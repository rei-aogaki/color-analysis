import './styles.css';
import { decode, validateFile } from './image/read.ts';
import { hexOf, percent } from './analysis/histogram.ts';
import { FAMILIES } from './analysis/families.ts';
import { discardEditor, openEditor, setupEditor } from './editor/editor.ts';
import type { Options, Query, Request, Response, Row, Summary } from './types.ts';

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!element) throw new Error('画面を初期化できません。'); return element as T;
}
const fileInput = el<HTMLInputElement>('file'), canvas = el<HTMLCanvasElement>('preview');
const viewport = el<HTMLDivElement>('viewport'), mode = el<HTMLSelectElement>('mode');
const settings = el<HTMLFieldSetElement>('settings'), notice = el<HTMLDivElement>('notice');
const analyzeButton = el<HTMLButtonElement>('analyze'), cancelButton = el<HTMLButtonElement>('cancel');
const progress = el<HTMLProgressElement>('progress');
let sourceId = 0, jobId = 0, requestId = 0, pageRequest = 0, exportRequest = 0;
let pixels: ImageData | undefined, worker: Worker | undefined, summary: Summary | undefined;
let busy: 'load' | 'analysis' | 'export' | undefined;
let page = 0, pageTotal = 0, downloadUrl: string | undefined, selectedX = 0, selectedY = 0;
let loadMs = 0, readStarted = 0;
let familyLabels: Uint8Array | undefined, maskedPixels: ImageData | undefined, selectedFamily: number | undefined;
let maskRevision = 0;
const fmt = (n: number) => n.toLocaleString('ja-JP');
const glancePercent = (ratio: number) => ratio > 0 && ratio < 0.0001 ? '<0.01' : (ratio * 100).toFixed(2);
const text = (id: string, value: string) => { el(id).textContent = value; };

function status(message: string, error = false) {
  notice.textContent = message; notice.classList.toggle('error', error);
}
function send(message: Request, transfer: Transferable[] = []) { worker?.postMessage(message, transfer); }
function discardDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined; const link = el<HTMLAnchorElement>('download'); link.hidden = true; link.removeAttribute('href');
}
function updateBusy(value: typeof busy) {
  busy = value; settings.disabled = !!busy; analyzeButton.disabled = !!busy || !pixels;
  cancelButton.hidden = !busy; progress.hidden = !busy;
  if (busy) { progress.removeAttribute('value'); progress.setAttribute('aria-label', busy === 'load' ? '画像の読み込み' : busy === 'export' ? '保存ファイルの準備' : '解析の進捗'); }
  for (const id of ['csv', 'json']) el<HTMLButtonElement>(id).disabled = !!busy || !summary;
  el<HTMLButtonElement>('sample').disabled = false;
  el<HTMLButtonElement>('open-editor').disabled = !pixels || busy === 'load';
  el('workspace').setAttribute('aria-busy', busy ? 'true' : 'false');
}
function discardResult() {
  maskRevision++; familyLabels = undefined; maskedPixels = undefined; selectedFamily = undefined;
  el('mask-status').hidden = true; el('family-panel').hidden = true; el('family-buttons').replaceChildren();
  if (pixels) inspect(selectedX, selectedY);
  worker?.terminate(); worker = undefined; jobId++; pageRequest = ++requestId; exportRequest = ++requestId;
  summary = undefined; page = 0; pageTotal = 0; el('results').hidden = true;
  el('overview').hidden = true; el('palette-panel').hidden = true;
  for (const id of ['dominant-name', 'dominant-ratio', 'overview-basis']) text(id, '');
  el('rows').replaceChildren(); el('chart').replaceChildren(); discardDownload();
}
function clear(message = '画像と解析結果をクリアしました。') {
  sourceId++; discardResult(); discardEditor(); pixels = undefined; canvas.width = canvas.height = 0;
  fileInput.value = '';
  mode.value = 'families'; el<HTMLSelectElement>('match').value = 'rgba'; el<HTMLSelectElement>('step').value = '32';
  el<HTMLInputElement>('include-transparent').checked = false;
  el<HTMLInputElement>('search').value = ''; el<HTMLSelectElement>('sort').value = 'count-desc';
  el<HTMLSelectElement>('zoom').value = 'fit';
  for (const id of ['pixel-tools', 'advanced-settings', 'table-details']) el<HTMLDetailsElement>(id).open = false;
  el<HTMLDetailsElement>('analysis-options').open = true;
  el('workspace').hidden = true; el('empty-guide').hidden = false;
  for (const id of ['image-name', 'image-size', 'timing', 'pixel-hex', 'pixel-rgba', 'search-help', 'alpha-stats', 'result-mode', 'page-info']) text(id, '');
  for (const id of ['total', 'included', 'excluded', 'color-count']) text(id, '—');
  el('pixel-swatch').replaceChildren(); el<HTMLInputElement>('pixel-x').value = el<HTMLInputElement>('pixel-y').value = '0';
  updateMode(); updateBusy(undefined); status(message);
}
function updateMode() {
  const exact = mode.value === 'exact';
  el('match-field').hidden = !exact; el('step-field').hidden = mode.value !== 'quantized';
  el('family-explanation').hidden = mode.value !== 'families';
  text('mode-description', mode.value === 'families' ? '明るい青・暗い青・くすんだ青も、青系として集計します。白・グレー・黒に近い色は別の系統です。' : exact ? '同じRGB値と、選んだ透明度の条件で集計します。' : 'RGBの数値を一定の区間で分類します。見た目が近い色が別グループになる場合もあります。');
  el<HTMLInputElement>('search').placeholder = exact && el<HTMLSelectElement>('match').value === 'rgba' ? '#RRGGBB / #RRGGBBAAで検索' : '#RRGGBBで検索';
  el<HTMLInputElement>('search').disabled = mode.value === 'families';
  if (mode.value === 'families') el<HTMLInputElement>('search').value = '';
}
function options(): Options {
  const alphaPolicy = el<HTMLInputElement>('include-transparent').checked ? 'all' : 'exclude-zero';
  if (mode.value === 'families') return { mode: 'families', alphaPolicy };
  return mode.value === 'quantized' ? { mode: 'quantized', step: el<HTMLSelectElement>('step').value === '16' ? 16 : 32, alphaPolicy } :
    { mode: 'exact', match: el<HTMLSelectElement>('match').value === 'rgb' ? 'rgb' : 'rgba', alphaPolicy };
}
function swatch(row: Row, target?: HTMLElement) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('swatch-svg');
  const rect = document.createElementNS(svg.namespaceURI, 'rect');
  rect.setAttribute('width', '32'); rect.setAttribute('height', '32');
  rect.setAttribute('fill', `rgb(${row.rgb.join(',')})`); rect.setAttribute('fill-opacity', String((row.alpha ?? 255) / 255)); svg.append(rect);
  const holder = target ?? document.createElement('span'); holder.classList.add('swatch'); holder.replaceChildren(svg); return holder;
}

async function load(file: File) {
  clear('画像を確認しています…'); const id = sourceId; updateBusy('load'); readStarted = performance.now();
  // Keep clear and cancel reachable while the workspace is not yet visible.
  el('workspace').hidden = false; el('empty-guide').hidden = true;
  text('image-name', file.name);
  try {
    const header = await validateFile(file); if (id !== sourceId) return;
    status('画像の全ピクセルを読み取っています…');
    const decoded = await decode(file, header);
    if (id !== sourceId) { decoded.bitmap.close(); return; }
    pixels = decoded.pixels; canvas.width = pixels.width; canvas.height = pixels.height;
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) { decoded.bitmap.close(); throw new Error('このブラウザでは画像を表示できません。'); }
    ctx.drawImage(decoded.bitmap, 0, 0); decoded.bitmap.close();
    text('image-size', `${fmt(pixels.width)} × ${fmt(pixels.height)} px · ${header.format}`);
    el<HTMLInputElement>('pixel-x').max = String(pixels.width - 1); el<HTMLInputElement>('pixel-y').max = String(pixels.height - 1);
    selectedX = selectedY = 0; loadMs = performance.now() - readStarted;
    updateBusy(undefined); resizePreview(); inspect(0, 0);
    text('timing', `読み込み ${(loadMs / 1000).toFixed(2)}秒`);
    status('画像を読み込みました。条件を確認して「解析する」を押してください。');
  } catch (error) {
    if (id !== sourceId) return;
    clear(''); status(error instanceof Error ? error.message : '画像を読み込めませんでした。', true);
  }
}

// Mobile browsers change innerHeight while the address bar collapses during scrolling.
// The probe measures 100svh (100vh as fallback), which stays fixed through those changes.
const viewportProbe = document.createElement('div');
viewportProbe.className = 'viewport-probe'; viewportProbe.setAttribute('aria-hidden', 'true'); document.body.append(viewportProbe);
const stableViewportHeight = () => viewportProbe.getBoundingClientRect().height || window.innerHeight;
function resizePreview() {
  if (!pixels) return;
  // Size the frame from the source aspect ratio, independently of the zoom level.
  const availableWidth = viewport.parentElement!.clientWidth;
  const heightLimit = Math.max(240, Math.min(720, Math.floor(stableViewportHeight() * 0.72)));
  const fitScale = Math.min(Math.max(1, availableWidth - 40) / pixels.width, (heightLimit - 40) / pixels.height, 1);
  const frameWidth = Math.min(availableWidth, Math.max(160, Math.ceil(pixels.width * fitScale) + 40));
  const frameHeight = Math.max(160, Math.ceil(pixels.height * fitScale) + 40);
  viewport.style.width = `${frameWidth}px`;
  viewport.style.height = `${frameHeight}px`;
  const value = el<HTMLSelectElement>('zoom').value;
  // Ignore scrollbars left over from the previous zoom when restoring the fit size.
  const scale = value === 'fit' ? Math.min((frameWidth - 40) / pixels.width, (frameHeight - 40) / pixels.height, 1) : Number(value);
  canvas.style.width = `${Math.max(1, pixels.width * scale)}px`;
  canvas.style.height = `${Math.max(1, pixels.height * scale)}px`;
  canvas.classList.toggle('pixelated', scale >= 1);
}
function inspect(x: number, y: number) {
  if (!pixels) return;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) {
    status('座標は画像の範囲内の整数で入力してください。', true); return;
  }
  selectedX = x; selectedY = y;
  el<HTMLInputElement>('pixel-x').value = String(x); el<HTMLInputElement>('pixel-y').value = String(y);
  const i = (y * pixels.width + x) * 4;
  const row: Row = { key: 0, rgb: [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]], alpha: pixels.data[i + 3], count: 1, ratio: 0 };
  text('pixel-hex', hexOf(row)); text('pixel-rgba', `RGB ${row.rgb.join(' / ')} · A ${row.alpha}`); swatch(row, el('pixel-swatch'));
  const context = canvas.getContext('2d')!;
  context.putImageData(maskedPixels ?? pixels, 0, 0);
  // Marker is display-only; source ImageData is never read back from this canvas.
  const markerSize = Math.max(1, Math.min(12, pixels.width / 90));
  context.strokeStyle = '#FFFFFF'; context.lineWidth = Math.max(1, markerSize / 4);
  context.strokeRect(x - markerSize / 2, y - markerSize / 2, markerSize, markerSize);
  context.strokeStyle = '#1D4ED8'; context.lineWidth = Math.max(1, markerSize / 8);
  context.strokeRect(x - markerSize / 2, y - markerSize / 2, markerSize, markerSize);
}

function renderSummary(s: Summary, top: Row[]) {
  el('results').hidden = false;
  el('overview').hidden = false; el('palette-panel').hidden = false;
  const analysisOptions = el<HTMLDetailsElement>('analysis-options');
  const keepFocus = analysisOptions.contains(document.activeElement);
  analysisOptions.open = false;
  if (keepFocus) analysisOptions.querySelector('summary')?.focus({ preventScroll: true });
  text('total', fmt(s.totalPixels)); text('included', fmt(s.includedPixels)); text('excluded', fmt(s.excludedPixels)); text('color-count', fmt(s.rowCount));
  const families = s.options.mode === 'families';
  const dominant = top[0];
  text('dominant-caption', families ? 'もっとも面積の大きい色系統' : s.options.mode === 'exact' ? 'もっとも多いカラーコード' : 'もっとも面積の大きいグループ');
  text('dominant-name', dominant ? dominant.family ?? hexOf(dominant) : '集計対象なし');
  text('dominant-ratio', dominant ? glancePercent(dominant.ratio) : '—');
  text('overview-basis', `${fmt(s.includedPixels)}ピクセルを100%として計算。画像の表示倍率や強調表示で数値は変わりません。`);
  text('row-count-label', families ? '使われている系統' : s.options.mode === 'exact' ? '異なる色' : 'グループ数');
  text('result-mode', families ? '色の傾向 / 色系統別' : s.options.mode === 'exact' ? `完全一致 / ${s.options.match.toUpperCase()}` : '似た色 / RGB区間分類');
  text('chart-title', families ? '色系統の割合' : '主な色の割合');
  text('chart-subtitle', families ? '全系統を表示 / 全対象ピクセル基準' : '上位10件 + その他 / 全対象ピクセル基準');
  text('color-column', families ? '系統 / 平均色' : 'カラーコード');
  el('family-panel').hidden = !families;
  el<HTMLInputElement>('search').disabled = families;
  if (families) renderFamilyButtons(s, top);
  text('alpha-stats', `画像全体の内訳：不透明 ${fmt(s.opaquePixels)} / 半透明 ${fmt(s.translucentPixels)} / 完全透明 ${fmt(s.transparentPixels)} ピクセル`);
  const chart = el('chart'); chart.replaceChildren();
  if (!s.includedPixels) { chart.textContent = '集計対象のピクセルがありません。透明部分を含める設定で再解析できます。'; return; }
  const shown = top.reduce((sum, row) => sum + row.count, 0);
  const items = top.map(row => ({ row, label: row.family ?? hexOf(row) }));
  if (shown < s.includedPixels) items.push({ row: { key: 0, rgb: [163, 163, 163], alpha: null, count: s.includedPixels - shown, ratio: (s.includedPixels - shown) / s.includedPixels }, label: 'その他' });
  const strip = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); strip.setAttribute('viewBox', '0 0 1000 36'); strip.setAttribute('preserveAspectRatio', 'none'); strip.classList.add('color-strip'); strip.setAttribute('aria-hidden', 'true');
  let x = 0; const legend = document.createElement('div'); legend.className = 'legend';
  for (const { row, label } of items) {
    const rect = document.createElementNS(strip.namespaceURI, 'rect'); rect.setAttribute('x', String(x * 1000)); rect.setAttribute('width', String(row.ratio * 1000)); rect.setAttribute('height', '36');
    rect.setAttribute('fill', `rgb(${row.rgb.join(',')})`); rect.setAttribute('fill-opacity', String((row.alpha ?? 255) / 255)); strip.append(rect); x += row.ratio;
    const item = document.createElement('div'); item.className = 'legend-item'; item.append(swatch(row));
    const code = document.createElement(families ? 'span' : 'code'); code.textContent = label; const value = document.createElement('span'); value.textContent = percent(row.ratio); item.append(code, value); legend.append(item);
  }
  chart.append(strip, legend);
}

function renderFamilyButtons(s: Summary, rows: Row[]) {
  const holder = el('family-buttons'); holder.replaceChildren();
  const unused = document.createElement('details'); unused.className = 'unused-families';
  const unusedTitle = document.createElement('summary'); unused.append(unusedTitle);
  let unusedCount = 0;
  for (const family of [...FAMILIES].sort((a, b) => (rows.find(r => r.key === b.key)?.count ?? 0) - (rows.find(r => r.key === a.key)?.count ?? 0))) {
    if (family.key === 12 && s.options.alphaPolicy === 'exclude-zero') continue;
    const row = rows.find(row => row.key === family.key);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'family-button';
    button.dataset.family = String(family.key); button.setAttribute('aria-pressed', String(selectedFamily === family.key));
    button.disabled = !row?.count;
    button.append(swatch({ key: family.key, rgb: [...family.color], alpha: family.key === 12 ? 0 : null, count: 0, ratio: 0 }));
    const label = document.createElement('span'); label.textContent = family.label;
    const ratio = document.createElement('strong'); ratio.textContent = `${glancePercent(row?.ratio ?? 0)}%`;
    const count = document.createElement('small'); count.textContent = `${fmt(row?.count ?? 0)} px`;
    button.append(label, ratio, count); button.addEventListener('click', () => { void showFamily(family.key); });
    if (row?.count) holder.append(button);
    else { unused.append(button); unusedCount++; }
  }
  if (unusedCount) { unusedTitle.textContent = `使われていない系統（${unusedCount}）`; holder.append(unused); }
}

async function showFamily(key?: number) {
  if (!pixels || !familyLabels || !summary || summary.options.mode !== 'families') return;
  if (key !== undefined && !FAMILIES.some(family => family.key === key)) return;
  const revision = ++maskRevision, source = pixels, labels = familyLabels;
  selectedFamily = key; maskedPixels = undefined;
  for (const button of el('family-buttons').querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.family) === key));
  el('mask-status').hidden = key === undefined;
  if (key === undefined) { inspect(selectedX, selectedY); return; }
  const label = FAMILIES[key].label;
  text('mask-status', `${label}の場所を準備中…`);
  // Work in chunks. A new selection, changed settings, or clear cancels the old rendering.
  try {
  const output = new Uint8ClampedArray(source.data.length);
  for (let start = 0; start < labels.length; start += 131072) {
    if (revision !== maskRevision) return;
    const end = Math.min(labels.length, start + 131072);
    for (let p = start; p < end; p++) {
      const i = p * 4;
      if (labels[p] === key) {
        if (key === 12) { output[i] = 36; output[i + 1] = 88; output[i + 2] = 223; output[i + 3] = 255; }
        else { output[i] = source.data[i]; output[i + 1] = source.data[i + 1]; output[i + 2] = source.data[i + 2]; output[i + 3] = source.data[i + 3]; }
      } else {
        output[i] = output[i + 1] = output[i + 2] = 35;
        output[i + 3] = source.data[i + 3] === 0 ? 0 : 230;
      }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (revision !== maskRevision) return;
  maskedPixels = new ImageData(output, source.width, source.height, { colorSpace: 'srgb' });
  inspect(selectedX, selectedY);
  text('mask-status', key === 12 ? '完全透明の場所を青で表示中。画素の数値・解析結果は元画像のままです。' : `${label}の場所を表示中。暗くした場所は対象外です。画素の数値・割合は元画像のままです。`);
  } catch {
    if (revision !== maskRevision) return;
    maskedPixels = undefined; selectedFamily = undefined; inspect(selectedX, selectedY);
    for (const button of el('family-buttons').querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
    text('mask-status', '強調表示を準備できませんでした。元画像を表示しています。解析結果は変わりません。');
  }
}
function queryRows() {
  if (!summary || !worker) return;
  const query: Query = { hex: el<HTMLInputElement>('search').value, sort: el<HTMLSelectElement>('sort').value as Query['sort'], page, pageSize: 50 };
  pageRequest = ++requestId; send({ type: 'query', jobId, requestId: pageRequest, query });
}
function renderRows(rows: Row[], total: number, actualPage: number) {
  page = actualPage; pageTotal = total; const body = el('rows'); body.replaceChildren(); text('search-help', '');
  for (const row of rows) {
    const tr = document.createElement('tr'); const color = document.createElement('td'); color.append(swatch(row)); tr.append(color);
    for (const [value, cls] of [[row.family ? `${row.family} · ${hexOf(row)}` : hexOf(row), row.family ? 'family-name' : 'mono'], [row.alpha === null ? '—' : String(row.alpha), 'mono'], [fmt(row.count), 'numeric mono'], [percent(row.ratio), 'numeric mono']]) {
      const td = document.createElement('td'); td.textContent = value; td.className = cls; tr.append(td);
    }
    body.append(tr);
  }
  if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = '該当する色がありません。'; td.className = 'table-empty'; tr.append(td); body.append(tr); }
  text('page-info', total ? `${fmt(page * 50 + 1)}–${fmt(Math.min((page + 1) * 50, total))} / ${fmt(total)}件` : '0件');
  el<HTMLButtonElement>('previous').disabled = page === 0; el<HTMLButtonElement>('next').disabled = (page + 1) * 50 >= pageTotal;
}
function startAnalysis() {
  if (!pixels || busy) return;
  discardResult(); const id = jobId; const source = sourceId;
  try {
    worker = new Worker(new URL('./workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Response>) => {
      const m = event.data; if (source !== sourceId || m.jobId !== id || id !== jobId) return;
      if (m.type === 'progress') { progress.value = m.percent; status(`${m.phase}… ${Math.floor(m.percent)}%`); }
      else if (m.type === 'complete') {
        familyLabels = m.familyLabels ? new Uint8Array(m.familyLabels) : undefined;
        summary = m.summary; updateBusy(undefined); renderSummary(m.summary, m.top); queryRows();
        text('timing', `読み込み ${(loadMs / 1000).toFixed(2)}秒 / 集計 ${(m.elapsedMs / 1000).toFixed(2)}秒`);
        status(`解析が完了しました。${fmt(m.summary.includedPixels)}ピクセルを集計しました。`);
      } else if (m.type === 'page' && m.requestId === pageRequest) renderRows(m.rows, m.total, m.page);
      else if (m.type === 'export-ready' && m.requestId === exportRequest && busy === 'export') {
        discardDownload(); downloadUrl = URL.createObjectURL(m.blob);
        const link = el<HTMLAnchorElement>('download'); link.href = downloadUrl; link.download = `color-analysis.${m.format}`;
        link.textContent = `${m.format.toUpperCase()}をダウンロード ↓`; link.hidden = false; updateBusy(undefined);
        status('ファイルの準備ができました。ダウンロードボタンを押して端末へ保存してください。'); link.focus();
      } else if (m.type === 'export-cancelled') { if (m.requestId === exportRequest && busy === 'export') { updateBusy(undefined); status('ファイルの準備をキャンセルしました。解析結果は残っています。'); } }
      else if (m.type === 'error') {
        if (m.phase === 'query' && m.requestId !== pageRequest || m.phase === 'export' && m.requestId !== exportRequest) return;
        if (m.phase === 'analysis') discardResult();
        if (m.phase === 'query') { text('search-help', m.message); renderRows([], 0, 0); text('search-help', m.message); }
        else { updateBusy(undefined); status(m.message, true); }
      }
    };
    worker.onerror = () => { discardResult(); updateBusy(undefined); status('解析プログラムを実行できませんでした。再解析するか、別のブラウザをお試しください。', true); };
    updateBusy('analysis'); status('全ピクセルの解析を開始しています…');
    const buffer = pixels.data.slice().buffer;
    send({ type: 'start', jobId: id, width: pixels.width, height: pixels.height, options: options(), buffer }, [buffer]);
  } catch { discardResult(); updateBusy(undefined); status('解析を開始できませんでした。メモリに余裕のある状態でお試しください。', true); }
}
function cancel() {
  if (busy === 'load') clear('画像の読み込みをキャンセルしました。');
  else if (busy === 'analysis') { discardResult(); updateBusy(undefined); status('解析をキャンセルしました。画像と設定は残っています。'); }
  else if (busy === 'export') { exportRequest = ++requestId; send({ type: 'cancel-export', jobId }); updateBusy(undefined); status('ファイルの準備をキャンセルしました。解析結果は残っています。'); }
}
function prepareExport(format: 'csv' | 'json') {
  if (!summary || busy) return; discardDownload(); updateBusy('export'); status(`${format.toUpperCase()}ファイルを準備しています…`);
  exportRequest = ++requestId; send({ type: 'export', jobId, requestId: exportRequest, format });
}

fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void load(file); fileInput.value = ''; });
el('drop-zone').addEventListener('dragover', event => { event.preventDefault(); el('drop-zone').classList.add('dragging'); });
el('drop-zone').addEventListener('dragleave', () => el('drop-zone').classList.remove('dragging'));
el('drop-zone').addEventListener('drop', event => {
  event.preventDefault(); el('drop-zone').classList.remove('dragging'); const files = (event as DragEvent).dataTransfer?.files;
  if (!files?.length) return;
  if (files.length !== 1) { clear(''); status('画像は1枚ずつ選択してください。', true); return; }
  void load(files[0]);
});
el('sample').addEventListener('click', () => {
  clear('サンプル画像を準備しています…'); const expectedSource = sourceId;
  const sample = document.createElement('canvas'); sample.width = 1200; sample.height = 800;
  const c = sample.getContext('2d')!;
  c.fillStyle = '#ECE8DF'; c.fillRect(0, 0, 1200, 800); c.fillStyle = '#335C81'; c.fillRect(720, 0, 480, 480);
  c.fillStyle = '#D48772'; c.fillRect(720, 480, 480, 320); c.fillStyle = '#243D38'; c.fillRect(0, 640, 720, 160);
  c.fillStyle = '#D48772'; c.beginPath(); c.arc(360, 320, 200, 0, Math.PI * 2); c.fill();
  sample.toBlob(blob => { if (blob && expectedSource === sourceId) void load(new File([blob], 'sample-palette.png', { type: 'image/png' })); sample.width = sample.height = 0; }, 'image/png');
});
el('clear').addEventListener('click', () => clear()); cancelButton.addEventListener('click', cancel); analyzeButton.addEventListener('click', startAnalysis);
el('open-editor').addEventListener('click', () => { if (pixels) openEditor(pixels, el('open-editor')); });
el('reset-family').addEventListener('click', () => { void showFamily(); });
settings.addEventListener('change', () => { updateMode(); discardResult(); updateBusy(undefined); status('条件が変わりました。「解析する」で再解析してください。'); });
el('zoom').addEventListener('change', resizePreview);
new ResizeObserver(resizePreview).observe(viewport.parentElement!);
window.addEventListener('resize', resizePreview);
const panControls = document.createElement('div'); panControls.className = 'pan-controls'; panControls.setAttribute('aria-label', '拡大画像の移動');
for (const [label, dx, dy] of [['←', -100, 0], ['↑', 0, -100], ['↓', 0, 100], ['→', 100, 0]] as const) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button small'; button.textContent = label;
  button.setAttribute('aria-label', `画像を${label === '←' ? '左' : label === '→' ? '右' : label === '↑' ? '上' : '下'}へ移動`);
  button.addEventListener('click', () => viewport.scrollBy({ left: dx, top: dy })); panControls.append(button);
}
el('zoom').closest('.preview-toolbar')!.append(panControls);
el('inspect').addEventListener('click', () => inspect(Number(el<HTMLInputElement>('pixel-x').value), Number(el<HTMLInputElement>('pixel-y').value)));
let pointer: { x: number; y: number; left: number; top: number; moved: boolean } | undefined;
canvas.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false }; });
canvas.addEventListener('pointermove', event => {
  if (!pointer || event.pointerType === 'touch') return;
  if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) pointer.moved = true;
  if (pointer.moved) { viewport.scrollLeft = pointer.left - event.clientX + pointer.x; viewport.scrollTop = pointer.top - event.clientY + pointer.y; }
});
canvas.addEventListener('pointerup', event => {
  if (!pixels || !pointer) return; const p = pointer; pointer = undefined;
  if (p.moved || Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) return;
  el<HTMLDetailsElement>('pixel-tools').open = true;
  const rect = canvas.getBoundingClientRect(); inspect(Math.floor((event.clientX - rect.left) / rect.width * pixels.width), Math.floor((event.clientY - rect.top) / rect.height * pixels.height));
});
canvas.addEventListener('pointercancel', () => { pointer = undefined; });
window.addEventListener('pointerup', () => { pointer = undefined; });
canvas.addEventListener('keydown', event => {
  if (!pixels || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  el<HTMLDetailsElement>('pixel-tools').open = true;
  event.preventDefault(); inspect(Math.max(0, Math.min(pixels.width - 1, selectedX + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))),
    Math.max(0, Math.min(pixels.height - 1, selectedY + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))));
});
el('search').addEventListener('input', () => { page = 0; queryRows(); }); el('sort').addEventListener('change', () => { page = 0; queryRows(); });
el('previous').addEventListener('click', () => { if (page > 0) { page--; queryRows(); } });
el('next').addEventListener('click', () => { if ((page + 1) * 50 < pageTotal) { page++; queryRows(); } });
el('csv').addEventListener('click', () => prepareExport('csv')); el('json').addEventListener('click', () => prepareExport('json'));
window.addEventListener('pagehide', () => clear()); window.addEventListener('pageshow', event => { if (event.persisted) clear(); });
setupEditor(); updateMode(); updateBusy(undefined);
if (!window.Worker || !window.createImageBitmap) { status('このブラウザは試作の画像読み取りに対応していません。新しいブラウザをお試しください。', true); fileInput.disabled = true; el<HTMLButtonElement>('sample').disabled = true; }
