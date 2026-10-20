import { applyStamp, clipRect, composite, luminance, stampsAlong, unionRect, type Point, type Rect } from './mask.ts';
import { MaskHistory } from './history.ts';
import { drawShape, SHAPES, type ShapeName } from './shapes.ts';

// Full-screen editor that restores the original color where the user paints over a monochrome image.
// State lives only in page memory and is released by discardEditor() (clear, image change, page exit).

type Session = { source: ImageData; gray: Uint8Array; mask: Uint8Array; history: MaskHistory };
const FILE_NAME = 'color-analysis-brush.png';
const MIN_SCREEN = 6, MAX_SCREEN = 200, MAX_IMAGE_BRUSH = 4096, STRIP_PIXELS = 1 << 20;

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!element) throw new Error('画面を初期化できません。'); return element as T;
}
let editor: HTMLElement, stage: HTMLDivElement, view: HTMLDivElement, canvas: HTMLCanvasElement, cursor: HTMLCanvasElement;
let session: Session | undefined, opener: HTMLElement | null = null;
let shape: ShapeName = 'circle', restore = true, moving = false, zoom = 1, comparing = false;
let fitScale = 1, displayScale = 1;
let dirty: Rect | undefined, frame = 0;
let stroke: { pointerId: number; last: Point; travelled: number } | undefined;
const touches = new Set<number>();
let drag: { x: number; y: number; left: number; top: number } | undefined;
let exportUrl: string | undefined, exportFile: File | undefined, exporting = 0;
let coverageCache: { key: string; data: Uint8Array } | undefined;
let cursorCache: { key: string; image: HTMLCanvasElement } | undefined;
let statusTimer = 0;

// Capture fails for pointers the browser no longer tracks; painting still works without it.
const capture = (element: Element, id: number) => { try { element.setPointerCapture(id); } catch { /* not capturable */ } };
const context = () => canvas.getContext('2d', { colorSpace: 'srgb' })!;
const sizeSlider = () => $<HTMLInputElement>('editor-size');
const screenSize = () => MIN_SCREEN * (MAX_SCREEN / MIN_SCREEN) ** (Number(sizeSlider().value) / 100);
const imageSize = () => Math.max(1, Math.min(MAX_IMAGE_BRUSH, Math.round(screenSize() / displayScale)));

function status(message: string, sticky = false) {
  const target = $('editor-status'); target.textContent = message; clearTimeout(statusTimer);
  if (!sticky && message) statusTimer = window.setTimeout(() => { target.textContent = ''; }, 4000);
}

/** Wire up the editor once at startup. */
export function setupEditor(): void {
  editor = $('editor'); stage = $('editor-stage'); view = $('editor-view');
  canvas = $('editor-canvas'); cursor = $('editor-cursor');
  for (const button of editor.querySelectorAll<HTMLButtonElement>('[data-shape]')) {
    const name = button.dataset.shape as ShapeName, icon = button.querySelector('canvas')!;
    icon.width = icon.height = 56; const c = icon.getContext('2d')!; c.fillStyle = '#33493D'; drawShape(c, name, 6, 6, 44);
    button.addEventListener('click', () => { shape = name; updateControls(); });
  }
  $('editor-restore').addEventListener('click', () => { restore = true; updateControls(); });
  $('editor-erase').addEventListener('click', () => { restore = false; updateControls(); });
  $('editor-move').addEventListener('click', () => { moving = !moving; updateControls(); status(moving ? '画像を動かせます。塗るときはもう一度「移動」を押してください。' : ''); });
  $('editor-zoom').addEventListener('change', event => setZoom(Number((event.target as HTMLSelectElement).value)));
  sizeSlider().addEventListener('input', () => { updateSizeLabel(); showCursorPreview(); });
  sizeSlider().addEventListener('change', hideCursor);
  $('editor-undo').addEventListener('click', undo); $('editor-redo').addEventListener('click', redo);
  $('editor-reset').addEventListener('click', resetAll);
  $('editor-close').addEventListener('click', closeEditor);
  $('editor-save').addEventListener('click', () => { void prepareExport(); });
  $('editor-share').addEventListener('click', () => { void share(); });
  const compare = $('editor-compare');
  compare.addEventListener('pointerdown', event => { capture(compare, event.pointerId); setComparing(true); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) compare.addEventListener(type, () => setComparing(false));
  compare.addEventListener('keydown', event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); setComparing(true); } });
  compare.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') setComparing(false); });
  compare.addEventListener('contextmenu', event => event.preventDefault());
  editor.addEventListener('keydown', onKey);
  // Listen on the whole stage, so a stroke may start in the margin around the image.
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  for (const type of ['pointerup', 'pointercancel']) stage.addEventListener(type, event => onPointerUp(event as PointerEvent));
  stage.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && !stroke) hideCursor(); });
  new ResizeObserver(() => { if (!editor.hidden) layout(); }).observe(view);
  updateControls();
}

export function openEditor(source: ImageData, from: HTMLElement | null): void {
  if (session?.source !== source) {
    discardEditor();
    const mask = new Uint8Array(source.width * source.height);
    session = { source, gray: luminance(source.data), mask, history: new MaskHistory(mask, source.width, source.height) };
    canvas.width = source.width; canvas.height = source.height;
    render({ x: 0, y: 0, w: source.width, h: source.height });
    status('なぞった所だけ、元の色に戻ります。');
  } else status('続きから編集できます。');
  opener = from;
  editor.hidden = false; document.documentElement.classList.add('editor-open');
  for (const element of document.querySelectorAll<HTMLElement>('body > :not(#editor)')) element.inert = true;
  zoom = 1; $<HTMLSelectElement>('editor-zoom').value = '1'; layout(); updateControls();
  $('editor-close').focus();
}

export function closeEditor(): void {
  if (!editor || editor.hidden) return;
  endStroke(); setComparing(false); hideCursor();
  editor.hidden = true; document.documentElement.classList.remove('editor-open');
  for (const element of document.querySelectorAll<HTMLElement>('body > :not(#editor)')) element.inert = false;
  opener?.focus(); opener = null;
}

/** Release every buffer of the current image. */
export function discardEditor(): void {
  closeEditor(); cancelAnimationFrame(frame); frame = 0; dirty = undefined;
  stroke = undefined; touches.clear(); session = undefined; coverageCache = undefined;
  discardExport(); exporting++;
  if (canvas) canvas.width = canvas.height = 0;
}

function layout() {
  if (!session) return;
  const { width, height } = session.source;
  const center = { x: (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth), y: (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight) };
  fitScale = Math.min((stage.clientWidth - 24) / width, (stage.clientHeight - 24) / height);
  if (!(fitScale > 0)) fitScale = 1;
  displayScale = fitScale * zoom;
  canvas.style.width = `${width * displayScale}px`; canvas.style.height = `${height * displayScale}px`;
  canvas.classList.toggle('pixelated', displayScale >= 4);
  stage.scrollLeft = center.x * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = center.y * stage.scrollHeight - stage.clientHeight / 2;
  const ratio = devicePixelRatio || 1;
  cursor.width = Math.round(view.clientWidth * ratio); cursor.height = Math.round(view.clientHeight * ratio);
  cursorCache = undefined; updateSizeLabel();
}
function setZoom(value: number) { zoom = [1, 2, 4].includes(value) ? value : 1; layout(); }

function updateControls() {
  for (const button of editor.querySelectorAll<HTMLButtonElement>('[data-shape]')) button.setAttribute('aria-pressed', String(button.dataset.shape === shape));
  $('editor-restore').setAttribute('aria-pressed', String(restore)); $('editor-erase').setAttribute('aria-pressed', String(!restore));
  $('editor-move').setAttribute('aria-pressed', String(moving)); editor.classList.toggle('moving', moving);
  $<HTMLButtonElement>('editor-undo').disabled = !session?.history.canUndo;
  $<HTMLButtonElement>('editor-redo').disabled = !session?.history.canRedo;
  canvas.setAttribute('aria-label', `${restore ? '色を戻す' : 'モノクロに戻す'}画像。${SHAPES[shape].label}の形でなぞるかタップしてください。`);
  updateSizeLabel();
}
function updateSizeLabel() {
  $('editor-size-value').textContent = session ? `画像上 ${imageSize().toLocaleString('ja-JP')}px` : '';
}

// --- Painting ---------------------------------------------------------------------------------

function toImage(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect(), { width, height } = session!.source;
  return { x: (event.clientX - rect.left) / rect.width * width, y: (event.clientY - rect.top) / rect.height * height };
}
function coverage(size: number): Uint8Array {
  const key = `${shape}:${size}`;
  if (coverageCache?.key === key) return coverageCache.data;
  const scratch = document.createElement('canvas'); scratch.width = scratch.height = size;
  const c = scratch.getContext('2d', { willReadFrequently: true })!; c.fillStyle = '#000'; drawShape(c, shape, 0, 0, size);
  const rgba = c.getImageData(0, 0, size, size).data, data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
  scratch.width = scratch.height = 0; coverageCache = { key, data }; return data;
}
function stamp(point: Point, size: number) {
  const s = session!, { width, height } = s.source, left = Math.round(point.x - size / 2), top = Math.round(point.y - size / 2);
  const area = clipRect({ x: left, y: top, w: size, h: size }, width, height); if (!area) return;
  s.history.touch(area);
  const changed = applyStamp(s.mask, width, height, coverage(size), size, size, left, top, restore);
  dirty = unionRect(dirty, changed); scheduleRender();
}
function onPointerDown(event: PointerEvent) {
  if (!session || comparing || event.button > 0) return;
  if (event.pointerType === 'touch') touches.add(event.pointerId);
  if (moving) {
    if (event.pointerType !== 'touch') { drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }; capture(stage, event.pointerId); }
    return;
  }
  // A second finger is not a brush: keep what was painted and stop the stroke.
  if (touches.size > 1) { endStroke(); return; }
  if (stroke) return;
  event.preventDefault(); capture(stage, event.pointerId);
  discardExport(); session.history.begin();
  const point = toImage(event); stroke = { pointerId: event.pointerId, last: point, travelled: 0 };
  stamp(point, imageSize()); drawCursor(event);
}
function onPointerMove(event: PointerEvent) {
  if (drag) { stage.scrollLeft = drag.left - event.clientX + drag.x; stage.scrollTop = drag.top - event.clientY + drag.y; return; }
  if (!session || moving) return;
  if (!stroke) { if (event.pointerType !== 'touch') drawCursor(event); return; }
  if (event.pointerId !== stroke.pointerId) return;
  const size = imageSize(), spacing = Math.max(1, size * SHAPES[shape].spacing);
  for (const sample of event.getCoalescedEvents?.() ?? [event]) {
    const point = toImage(sample), walk = stampsAlong(stroke.last, point, spacing, stroke.travelled);
    for (const p of walk.points) stamp(p, size);
    stroke.last = point; stroke.travelled = walk.travelled;
  }
  drawCursor(event);
}
function onPointerUp(event: PointerEvent) {
  touches.delete(event.pointerId); drag = undefined;
  if (stroke?.pointerId === event.pointerId) endStroke();
  if (event.pointerType === 'touch' || event.type === 'pointercancel') hideCursor();
}
function endStroke() {
  if (!stroke || !session) { stroke = undefined; return; }
  stroke = undefined; session.history.end(); updateControls();
}

function undo() {
  if (!session || stroke) return; discardExport();
  const area = session.history.undo(); if (area) { render(area); status('ひと筆、元に戻しました。'); }
  updateControls();
}
function redo() {
  if (!session || stroke) return; discardExport();
  const area = session.history.redo(); if (area) { render(area); status('やり直しました。'); }
  updateControls();
}
function resetAll() {
  if (!session || stroke) return;
  const { mask, history, source } = session; if (!mask.some(v => v !== 0)) { status('すでに全部モノクロです。'); return; }
  discardExport(); const all = { x: 0, y: 0, w: source.width, h: source.height };
  history.begin(); history.touch(all); mask.fill(0); history.end();
  render(all); updateControls(); status('全部モノクロに戻しました。↶で元に戻せます。');
}
function onKey(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
  if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
  else if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  else if (mod && key === 'y') { event.preventDefault(); redo(); }
}

// --- Rendering --------------------------------------------------------------------------------

function scheduleRender() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (dirty) { const area = dirty; dirty = undefined; render(area); } }); }
function render(area: Rect) {
  const s = session; if (!s || comparing) return;
  const c = context(), rows = Math.max(1, Math.floor(STRIP_PIXELS / area.w));
  for (let y = area.y; y < area.y + area.h; y += rows) {
    const strip = { x: area.x, y, w: area.w, h: Math.min(rows, area.y + area.h - y) };
    const image = new ImageData(strip.w, strip.h, { colorSpace: 'srgb' });
    composite(s.source.data, s.gray, s.mask, s.source.width, strip, image.data);
    c.putImageData(image, strip.x, strip.y);
  }
}
function flushRender() { cancelAnimationFrame(frame); frame = 0; if (dirty) { const area = dirty; dirty = undefined; render(area); } }
function setComparing(value: boolean) {
  if (!session || value === comparing) return;
  if (value) { flushRender(); comparing = true; context().putImageData(session.source, 0, 0); }
  else { comparing = false; render({ x: 0, y: 0, w: session.source.width, h: session.source.height }); }
  $('editor-compare').setAttribute('aria-pressed', String(comparing));
}

// --- Brush preview on top of the image ----------------------------------------------------------

function cursorImage(): HTMLCanvasElement {
  const ratio = devicePixelRatio || 1, size = Math.max(4, Math.round(imageSize() * displayScale * ratio)), key = `${shape}:${size}`;
  if (cursorCache?.key === key) return cursorCache.image;
  // Outline only: a dark ring with a light halo stays visible on any photo.
  const pad = 4, image = document.createElement('canvas'); image.width = image.height = size + pad * 2;
  const c = image.getContext('2d')!;
  const ring = (color: string, offset: number) => { c.fillStyle = color; for (const [dx, dy] of [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]) drawShape(c, shape, pad + dx * offset, pad + dy * offset, size); };
  ring('rgba(255,255,255,.95)', 2 * ratio); ring('#1D2B25', ratio);
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000';
  drawShape(c, shape, pad, pad, size);
  cursorCache = { key, image }; return image;
}
function drawCursor(event: PointerEvent) {
  const c = cursor.getContext('2d')!, ratio = devicePixelRatio || 1, box = view.getBoundingClientRect(), image = cursorImage();
  c.clearRect(0, 0, cursor.width, cursor.height);
  c.drawImage(image, Math.round((event.clientX - box.left) * ratio - image.width / 2), Math.round((event.clientY - box.top) * ratio - image.height / 2));
}
function showCursorPreview() {
  if (!session || editor.hidden) return;
  const box = view.getBoundingClientRect();
  drawCursor({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 } as PointerEvent);
}
function hideCursor() { cursor.getContext('2d')?.clearRect(0, 0, cursor.width, cursor.height); }

// --- Saving -----------------------------------------------------------------------------------

function discardExport() {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = undefined; exportFile = undefined;
  if (!editor) return;
  $('editor-export').hidden = true; const link = $<HTMLAnchorElement>('editor-download'); link.removeAttribute('href');
}
async function prepareExport() {
  if (!session || stroke) return;
  setComparing(false); flushRender(); discardExport();
  const id = ++exporting, save = $<HTMLButtonElement>('editor-save'); save.disabled = true;
  status('保存用のPNGを作成しています…', true);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (id !== exporting) return;
  save.disabled = false;
  if (!blob) { status('画像を作成できませんでした。メモリに余裕のある状態でお試しください。', true); return; }
  exportFile = new File([blob], FILE_NAME, { type: 'image/png' }); exportUrl = URL.createObjectURL(blob);
  const link = $<HTMLAnchorElement>('editor-download'); link.href = exportUrl; link.download = FILE_NAME;
  const canShare = !!navigator.canShare?.({ files: [exportFile] });
  $('editor-share').hidden = !canShare;
  $('editor-export-size').textContent = `PNG ${session.source.width.toLocaleString('ja-JP')} × ${session.source.height.toLocaleString('ja-JP')} px · ${(blob.size / 1024 / 1024).toFixed(1)}MB`;
  $('editor-export').hidden = false; status('');
  (canShare ? $('editor-share') : link).focus();
}
async function share() {
  if (!exportFile) return;
  try { await navigator.share({ files: [exportFile] }); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) status('共有できませんでした。「ダウンロード」で保存してください。', true); }
}
