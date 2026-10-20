import type { Options, Query, Row, Summary } from '../types.ts';
import { classifyFamily, EXCLUDED_FAMILY, FAMILIES, FAMILY_RULE } from './families.ts';

export const MAX_COLORS = 1_000_000;
export const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function validateOptions(value: Options): void {
  if (!value || !['all', 'exclude-zero'].includes(value.alphaPolicy) ||
    (value.mode === 'exact' ? !['rgb', 'rgba'].includes(value.match) :
      value.mode !== 'families' && (value.mode !== 'quantized' || ![16, 32].includes(value.step)))) {
    throw new Error('解析条件が正しくありません。設定を選び直してください。');
  }
}

export class Histogram {
  readonly summary: Summary;
  readonly keys: Uint32Array;
  readonly counts: Uint32Array;
  readonly colors: Uint32Array;
  readonly order: Uint32Array;
  private colorOrder: Uint32Array | undefined;
  readonly familyLabels?: Uint8Array;

  constructor(summary: Summary, keys: Uint32Array, counts: Uint32Array, colors: Uint32Array, familyLabels?: Uint8Array) {
    this.summary = summary; this.keys = keys; this.counts = counts; this.colors = colors;
    this.familyLabels = familyLabels;
    this.order = Uint32Array.from(keys, (_, i) => i);
    this.order.sort((a, b) => counts[b] - counts[a] || keys[a] - keys[b]);
  }

  row(index: number): Row {
    const c = this.colors[index];
    return { key: this.keys[index], rgb: [Math.floor(c / 65536), Math.floor(c / 256) % 256, c % 256],
      alpha: this.summary.options.mode === 'exact' && this.summary.options.match === 'rgba' ? this.keys[index] % 256 : this.summary.options.mode === 'families' && this.keys[index] === 12 ? 0 : null,
      count: this.counts[index], ratio: this.summary.includedPixels ? this.counts[index] / this.summary.includedPixels : 0,
      ...(this.summary.options.mode === 'families' ? { family: FAMILIES[this.keys[index]].label } : {}) };
  }

  query(query: Query): { rows: Row[]; total: number; page: number } {
    if (!query || ![50, 100, 200].includes(query.pageSize) || !Number.isSafeInteger(query.page) || query.page < 0 ||
      !['count-desc', 'color-asc'].includes(query.sort) || typeof query.hex !== 'string') throw new Error('表示条件が正しくありません。');
    const hex = query.hex.trim().toUpperCase();
    const rgba = this.summary.options.mode === 'exact' && this.summary.options.match === 'rgba';
    if (hex && !(rgba ? /^#[\dA-F]{6}([\dA-F]{2})?$/ : /^#[\dA-F]{6}$/).test(hex)) {
      throw new Error(rgba ? '#RRGGBB または #RRGGBBAA を入力してください。' : '#RRGGBB を入力してください。');
    }
    if (query.sort === 'color-asc' && !this.colorOrder) {
      this.colorOrder = this.order.slice().sort((a, b) => this.colors[a] - this.colors[b] || this.keys[a] - this.keys[b]);
    }
    const order = query.sort === 'color-asc' ? this.colorOrder! : this.order;
    const color = hex ? parseInt(hex.slice(1, 7), 16) : -1;
    const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) : -1;
    const matches = (index: number) => color < 0 || (this.colors[index] === color && (alpha < 0 || this.keys[index] % 256 === alpha));
    let total = 0;
    for (const index of order) if (matches(index)) total++;
    const page = Math.min(query.page, Math.max(0, Math.ceil(total / query.pageSize) - 1));
    const rows: Row[] = []; let found = 0;
    for (const index of order) {
      if (!matches(index)) continue;
      if (found >= page * query.pageSize && rows.length < query.pageSize) rows.push(this.row(index));
      found++;
      if (rows.length === query.pageSize) break;
    }
    return { rows, total, page };
  }
}

export async function analyzePixels(data: Uint8ClampedArray, width: number, height: number, options: Options,
  progress: (phase: string, percent: number) => void = () => {}, maxColors = MAX_COLORS): Promise<Histogram> {
  validateOptions(options);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    width > 8192 || height > 8192 || width * height > 16_000_000 || data.length !== width * height * 4) throw new Error('画素データの大きさが正しくありません。');
  const exact = new Map<number, number>();
  const bins = options.mode === 'quantized' ? new Float64Array((256 / options.step) ** 3 * 4) : options.mode === 'families' ? new Float64Array(FAMILIES.length * 4) : undefined;
  const labels = options.mode === 'families' ? new Uint8Array(width * height).fill(EXCLUDED_FAMILY) : undefined;
  let transparent = 0, translucent = 0, opaque = 0, included = 0;
  const pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a === 0) transparent++; else if (a === 255) opaque++; else translucent++;
    if (!(a === 0 && options.alphaPolicy === 'exclude-zero')) {
      included++;
      if (options.mode === 'exact') {
        const key = options.match === 'rgba' ? r * 16777216 + g * 65536 + b * 256 + a : r * 65536 + g * 256 + b;
        exact.set(key, (exact.get(key) ?? 0) + 1);
        if (exact.size > maxColors) throw new Error('異なる色が上限の100万色を超えました。部分結果は表示しません。「似た色をまとめる」で再解析できます。');
      } else if (options.mode === 'quantized') {
        const s = options.step, q = 256 / s, k = (Math.floor(r / s) * q * q + Math.floor(g / s) * q + Math.floor(b / s)) * 4;
        bins![k]++; bins![k + 1] += r; bins![k + 2] += g; bins![k + 3] += b;
      } else {
        const family = classifyFamily(r, g, b, a), k = family * 4;
        labels![p] = family; bins![k]++;
        bins![k + 1] += r; bins![k + 2] += g; bins![k + 3] += b;
      }
    }
    if (p > 0 && p % 262144 === 0) { progress('ピクセルを集計中', p / pixels * 100); await yieldTask(); }
  }
  progress('結果を整列中', 100); await yieldTask();
  let length = exact.size;
  if (bins) { length = 0; for (let k = 0; k < bins.length; k += 4) if (bins[k]) length++; }
  const keys = new Uint32Array(length), counts = new Uint32Array(length), colors = new Uint32Array(length);
  let at = 0;
  if (options.mode === 'exact') {
    for (const [key, count] of exact) { keys[at] = key; counts[at] = count; colors[at] = options.match === 'rgba' ? Math.floor(key / 256) : key; at++; }
  } else {
    for (let k = 0; k < bins!.length; k += 4) if (bins![k]) {
      keys[at] = k / 4; counts[at] = bins![k];
      colors[at] = Math.round(bins![k + 1] / bins![k]) * 65536 + Math.round(bins![k + 2] / bins![k]) * 256 + Math.round(bins![k + 3] / bins![k]); at++;
    }
  }
  exact.clear();
  const summary: Summary = { schemaVersion: 2, appVersion: '0.3.0', measurementBasis: 'canvas-srgb-rgba8', width, height, options: { ...options },
    ...(options.mode === 'families' ? { classification: { ...FAMILY_RULE } } : {}),
    totalPixels: pixels, includedPixels: included, excludedPixels: pixels - included,
    transparentPixels: transparent, translucentPixels: translucent, opaquePixels: opaque, rowCount: length };
  return new Histogram(summary, keys, counts, colors, labels);
}

export function hexOf(row: Row): string {
  return '#' + [...row.rgb, ...(row.alpha === null ? [] : [row.alpha])].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function percent(ratio: number): string {
  return ratio > 0 && ratio * 100 < .0001 ? '<0.0001%' : (ratio * 100).toFixed(4) + '%';
}
