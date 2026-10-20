import { toLinear, type Rect } from './mask.ts';

// "Similar color" selection for the color restore editor. No DOM access, so it runs under node --test.
// Colors are compared in OKLab. Lightness counts less than hue and chroma, so the shaded and lit
// sides of the same object are picked together.

export type Selection = { rect: Rect; coverage: Uint8Array };
const LIGHTNESS_WEIGHT = 0.35;

function oklab(r: number, g: number, b: number, out: Float64Array) {
  const lr = toLinear[r], lg = toLinear[g], lb = toLinear[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

// Pixels are compared through a table of 64 levels per channel (2^18 colors): each table color is
// tested against the seed once, then each pixel is a single lookup. The 4-step rounding is far
// below the smallest tolerance, and it keeps a 16-megapixel selection fast enough to follow a slider.
const LEVELS = 64, SHIFT = 2;
let table: Float32Array | undefined;
function labTable(): Float32Array {
  if (table) return table;
  table = new Float32Array(LEVELS ** 3 * 3); const lab = new Float64Array(3);
  const level = (v: number) => Math.min(255, (v << SHIFT) + 2);
  for (let r = 0, k = 0; r < LEVELS; r++) for (let g = 0; g < LEVELS; g++) for (let b = 0; b < LEVELS; b++, k += 3) {
    oklab(level(r), level(g), level(b), lab); table[k] = lab[0]; table[k + 1] = lab[1]; table[k + 2] = lab[2];
  }
  return table;
}

/** Tolerance 0–1 as an OKLab distance: 0 keeps nearly identical colors, 1 reaches broadly related ones. */
export const thresholdOf = (tolerance: number) => 0.03 + Math.min(1, Math.max(0, tolerance)) * 0.22;

/**
 * Pixels similar to the color around (x, y). connected limits the result to the area reachable
 * from (x, y) without crossing other colors; otherwise similar pixels anywhere are included.
 * Transparent pixels are never selected. Returns undefined when the seed is transparent or off the image.
 * coverage is 255 inside and fades over one pixel outside, so edges are not jagged.
 */
export function selectSimilar(data: Uint8ClampedArray, width: number, height: number, x: number, y: number,
  tolerance: number, connected: boolean): Selection | undefined {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height || data[(y * width + x) * 4 + 3] === 0) return undefined;
  // Average the nearby pixels that resemble the tapped one, so noise does not decide the color
  // but a neighboring object at an edge is not mixed in.
  const lab = new Float64Array(3), center = new Float64Array(3), seed = [0, 0, 0]; let samples = 0;
  const c = (y * width + x) * 4; oklab(data[c], data[c + 1], data[c + 2], center);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const sx = x + dx, sy = y + dy; if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const i = (sy * width + sx) * 4; if (data[i + 3] === 0) continue;
    oklab(data[i], data[i + 1], data[i + 2], lab);
    if ((lab[0] - center[0]) ** 2 + (lab[1] - center[1]) ** 2 + (lab[2] - center[2]) ** 2 > 0.05 ** 2) continue;
    seed[0] += lab[0]; seed[1] += lab[1]; seed[2] += lab[2]; samples++;
  }
  const [L, A, B] = seed.map(v => v / samples), limit = thresholdOf(tolerance) ** 2, labs = labTable();
  const match = new Uint8Array(LEVELS ** 3);
  for (let k = 0; k < match.length; k++) {
    const dl = labs[k * 3] - L, da = labs[k * 3 + 1] - A, db = labs[k * 3 + 2] - B;
    if (LIGHTNESS_WEIGHT * dl * dl + da * da + db * db <= limit) match[k] = 1;
  }
  const similar = (p: number) => {
    const i = p * 4;
    return data[i + 3] !== 0 && match[(data[i] >> SHIFT) << 12 | (data[i + 1] >> SHIFT) << 6 | data[i + 2] >> SHIFT] === 1;
  };
  const selected = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const mark = (p: number) => {
    selected[p] = 1; const px = p % width, py = (p - px) / width;
    if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  if (connected) {
    // 2 marks pixels already checked and rejected, so each pixel is tested at most once.
    const stack = new Int32Array(width * height); let top = 0;
    const visit = (q: number) => { if (selected[q]) return; if (similar(q)) { mark(q); stack[top++] = q; } else selected[q] = 2; };
    // The tapped pixel always starts the area, even if it differs from its neighborhood average.
    const start = y * width + x; mark(start); stack[top++] = start;
    while (top) {
      const p = stack[--top], px = p % width;
      if (px > 0) visit(p - 1); if (px < width - 1) visit(p + 1);
      if (p >= width) visit(p - width); if (p + width < selected.length) visit(p + width);
    }
  } else {
    for (let py = 0, p = 0; py < height; py++) {
      let rowMin = -1, rowMax = -1;
      for (let px = 0; px < width; px++, p++) if (similar(p)) { selected[p] = 1; if (rowMin < 0) rowMin = px; rowMax = px; }
      if (rowMin >= 0) { if (rowMin < minX) minX = rowMin; if (rowMax > maxX) maxX = rowMax; if (py < minY) minY = py; maxY = py; }
    }
    if (maxX < 0) mark(y * width + x);
  }
  // Grow the rectangle by one pixel for the soft edge.
  const rect = { x: Math.max(0, minX - 1), y: Math.max(0, minY - 1), w: 0, h: 0 };
  rect.w = Math.min(width - 1, maxX + 1) - rect.x + 1; rect.h = Math.min(height - 1, maxY + 1) - rect.y + 1;
  const coverage = new Uint8Array(rect.w * rect.h);
  for (let cy = 0; cy < rect.h; cy++) for (let cx = 0; cx < rect.w; cx++) {
    const px = rect.x + cx, py = rect.y + cy;
    if (selected[py * width + px] === 1) { coverage[cy * rect.w + cx] = 255; continue; }
    let inside = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && selected[ny * width + nx] === 1) inside++;
    }
    if (inside) coverage[cy * rect.w + cx] = Math.round(inside * 255 / 9 * 0.6);
  }
  return { rect, coverage };
}
