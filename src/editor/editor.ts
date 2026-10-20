import { applyStamp, clipRect, composite, luminance, occupiedRatio, stampsAlong, unionRect, type Look, type Planes, type Point, type Rect } from './mask.ts';
import { MaskHistory } from './history.ts';
import { selectSimilar } from './select.ts';
import { drawShape, shapePaths, SHAPES, type ShapeName } from './shapes.ts';

// Full-screen editor that restores the original color where the user paints over a monochrome image.
// State lives only in page memory and is released by discardEditor() (clear, image change, page exit).

type Session = { source: ImageData; gray: Uint8Array; planes: Planes; history: MaskHistory };
// A rasterized brush: color coverage, plus rim and shadow when the sticker look is on. All n × n, centered.
type Stamp = { n: number; color: Uint8Array; rim?: Uint8Array; shadow?: Uint8Array };
const FILE_NAME = 'color-analysis-brush.png';
const MIN_SCREEN = 6, MAX_SCREEN = 200, MAX_IMAGE_BRUSH = 4096, STRIP_PIXELS = 1 << 20;

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!element) throw new Error('画面を初期化できません。'); return element as T;
}
let editor: HTMLElement, stage: HTMLDivElement, view: HTMLDivElement, canvas: HTMLCanvasElement, cursor: HTMLCanvasElement;
let session: Session | undefined, opener: HTMLElement | null = null;
// tool is the pressed button; shape remembers the last brush shape for stamping.
let tool: ShapeName | 'similar' = 'similar', shape: ShapeName = 'circle', restore = true, moving = false, zoom = 1, comparing = false;
let fitScale = 1, displayScale = 1;
let dirty: Rect | undefined, frame = 0;
let stroke: { pointerId: number; last: Point; travelled: number; taps: Point[] } | undefined;
// The last similar-color stroke, re-applied live while the tolerance changes.
let wand: Point[] | undefined, wandFrame = 0;
const touches = new Set<number>();
let drag: { x: number; y: number; left: number; top: number } | undefined;
let exportUrl: string | undefined, exportFile: File | undefined, exporting = 0;
let stampCache: { key: string; stamp: Stamp } | undefined;
let sticker = true, look: Look = { dim: 0, vivid: 1 };
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
    const name = button.dataset.shape as ShapeName | 'similar', icon = button.querySelector('canvas')!;
    icon.width = icon.height = 56; const c = icon.getContext('2d')!; c.fillStyle = '#33493D';
    if (name === 'similar') drawSparkle(c); else drawShape(c, name, 6, 6, 44);
    button.addEventListener('click', () => { tool = name; if (name !== 'similar') shape = name; wand = undefined; updateControls(); });
  }
  $('editor-restore').addEventListener('click', () => { restore = true; updateControls(); });
  $('editor-erase').addEventListener('click', () => { restore = false; updateControls(); });
  $('editor-move').addEventListener('click', () => { moving = !moving; updateControls(); status(moving ? '画像を動かせます。塗るときはもう一度「移動」を押してください。' : ''); });
  $('editor-zoom').addEventListener('change', event => setZoom(Number((event.target as HTMLSelectElement).value)));
  sizeSlider().addEventListener('input', () => { updateSizeLabel(); showCursorPreview(); });
  sizeSlider().addEventListener('change', hideCursor);
  $<HTMLInputElement>('editor-sticker').addEventListener('change', event => { sticker = (event.target as HTMLInputElement).checked; stampCache = undefined; });
  for (const id of ['editor-vivid', 'editor-dim']) $(id).addEventListener('input', () => { readLook(); discardExport(); if (session) { dirty = fullRect(); scheduleRender(); } });
  readLook();
  $('editor-tolerance').addEventListener('input', reapplyWand); $('editor-connected').addEventListener('change', reapplyWand);
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
    const size = source.width * source.height;
    const planes = { mask: new Uint8Array(size), rim: new Uint8Array(size), shadow: new Uint8Array(size) };
    session = { source, gray: luminance(source.data), planes, history: new MaskHistory([planes.mask, planes.rim, planes.shadow], source.width, source.height) };
    canvas.width = source.width; canvas.height = source.height;
    render(fullRect());
    status('なぞった所だけ、元の色に戻ります。');
  } else status('続きから編集できます。');
  opener = from;
  editor.hidden = false; document.documentElement.classList.add('editor-open');
  for (const element of document.querySelectorAll<HTMLElement>('body > :not(#editor)')) element.inert = true;
  zoom = 1; $<HTMLSelectElement>('editor-zoom').value = '1'; layout(); updateControls();
  // Look settings stay open where there is room for them.
  $<HTMLDetailsElement>('editor-look').open = matchMedia('(min-width: 900px)').matches;
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
  stroke = undefined; touches.clear(); session = undefined; stampCache = undefined; wand = undefined;
  cancelAnimationFrame(wandFrame); wandFrame = 0;
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
  for (const button of editor.querySelectorAll<HTMLButtonElement>('[data-shape]')) button.setAttribute('aria-pressed', String(button.dataset.shape === tool));
  $('editor-size-row').hidden = tool === 'similar'; $('editor-similar-options').hidden = tool !== 'similar';
  $('editor-restore').setAttribute('aria-pressed', String(restore)); $('editor-erase').setAttribute('aria-pressed', String(!restore));
  $('editor-move').setAttribute('aria-pressed', String(moving)); editor.classList.toggle('moving', moving);
  $<HTMLButtonElement>('editor-undo').disabled = !session?.history.canUndo;
  $<HTMLButtonElement>('editor-redo').disabled = !session?.history.canRedo;
  canvas.setAttribute('aria-label', `${restore ? '色を戻す' : 'モノクロに戻す'}画像。` +
    (tool === 'similar' ? 'タップした所と似た色をまとめて切り替えます。' : `${SHAPES[shape].label}の形でなぞるかタップしてください。`));
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
function readLook() {
  look = { vivid: 1 + Number($<HTMLInputElement>('editor-vivid').value) / 100 * 0.8, dim: Number($<HTMLInputElement>('editor-dim').value) / 100 * 0.6 };
}
const fullRect = (): Rect => ({ x: 0, y: 0, w: session!.source.width, h: session!.source.height });

function makeStamp(size: number): Stamp {
  const decorated = sticker && restore, key = `${shape}:${size}:${decorated}`;
  if (stampCache?.key === key) return stampCache.stamp;
  // The sticker rim scales with the brush; the shadow falls slightly below it.
  const rimWidth = decorated ? Math.max(2, Math.round(size * 0.07)) : 0, blur = decorated ? Math.max(2, Math.round(size * 0.05)) : 0;
  const drop = decorated ? Math.max(1, Math.round(size * 0.04)) : 0, margin = rimWidth + blur * 2 + drop, n = size + margin * 2;
  const scratch = document.createElement('canvas'); scratch.width = scratch.height = n;
  const c = scratch.getContext('2d', { willReadFrequently: true })!;
  const read = (draw: () => void) => {
    c.clearRect(0, 0, n, n); c.save(); draw(); c.restore();
    const rgba = c.getImageData(0, 0, n, n).data, data = new Uint8Array(n * n);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
    return data;
  };
  const { body, holes } = shapePaths(shape), unit = size / 100;
  const outline = (x: number) => { c.translate(x, margin); c.scale(unit, unit); c.lineWidth = rimWidth * 2 / unit; c.lineJoin = 'round'; c.fill(body); c.stroke(body); };
  const color = read(() => { c.fillStyle = '#000'; drawShape(c, shape, margin, margin, size); });
  let rim: Uint8Array | undefined, shadow: Uint8Array | undefined;
  if (decorated) {
    rim = read(() => { c.fillStyle = c.strokeStyle = '#000'; outline(margin); if (holes) { c.globalCompositeOperation = 'destination-out'; c.fill(holes); } });
    // Draw the rim far to the left and let only its shadow land on the canvas.
    shadow = read(() => { c.fillStyle = c.strokeStyle = '#000'; c.shadowColor = '#000'; c.shadowBlur = blur * 2; c.shadowOffsetX = n * 3; c.shadowOffsetY = drop; outline(margin - n * 3); });
  }
  scratch.width = scratch.height = 0;
  const stamp = { n, color, rim, shadow }; stampCache = { key, stamp }; return stamp;
}
/** Place one brush stamp. With avoidOverlap, a stamp that would cover earlier color or rims is skipped. */
function stamp(point: Point, size: number, avoidOverlap = false): boolean {
  const s = session!, { width, height } = s.source, b = makeStamp(size);
  const left = Math.round(point.x - b.n / 2), top = Math.round(point.y - b.n / 2);
  const area = clipRect({ x: left, y: top, w: b.n, h: b.n }, width, height); if (!area) return false;
  if (avoidOverlap && occupiedRatio(s.planes, width, height, b.color, b.n, left, top) > 0.02) return false;
  s.history.touch(area);
  const { mask, rim, shadow } = s.planes;
  let changed = applyStamp(mask, width, height, b.color, b.n, b.n, left, top, restore);
  if (!restore) {
    // Erasing also removes rims and shadows under the brush.
    applyStamp(rim, width, height, b.color, b.n, b.n, left, top, false); applyStamp(shadow, width, height, b.color, b.n, b.n, left, top, false);
  } else if (b.rim && b.shadow) {
    changed = unionRect(changed, applyStamp(rim, width, height, b.rim, b.n, b.n, left, top, true));
    changed = unionRect(changed, applyStamp(shadow, width, height, b.shadow, b.n, b.n, left, top, true));
  }
  dirty = unionRect(dirty, changed); scheduleRender(); return true;
}
const tolerance = () => Number($<HTMLInputElement>('editor-tolerance').value) / 100;
/** Restore (or erase) every pixel similar to the color at point. */
function applySimilar(point: Point): boolean {
  const s = session!, { width, height } = s.source;
  const selection = selectSimilar(s.source.data, width, height, point.x, point.y, tolerance(), $<HTMLInputElement>('editor-connected').checked);
  if (!selection) return false;
  const { rect, coverage } = selection, { mask, rim, shadow } = s.planes;
  s.history.touch(rect);
  const changed = applyStamp(mask, width, height, coverage, rect.w, rect.h, rect.x, rect.y, restore);
  if (!restore) { applyStamp(rim, width, height, coverage, rect.w, rect.h, rect.x, rect.y, false); applyStamp(shadow, width, height, coverage, rect.w, rect.h, rect.x, rect.y, false); }
  dirty = unionRect(dirty, changed); scheduleRender(); return true;
}
/** Redo the last similar-color stroke with the current tolerance, replacing it in the history. */
function reapplyWand() {
  if (!wand || !session || stroke || wandFrame) return;
  wandFrame = requestAnimationFrame(() => {
    wandFrame = 0; const points = wand; if (!points || !session || stroke) return;
    discardExport(); const undone = session.history.undo(); if (undone) dirty = unionRect(dirty, undone);
    session.history.begin(); for (const point of points) applySimilar(point);
    if (!session.history.end()) wand = undefined;
    flushRender(); updateControls();
  });
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
  const point = toImage(event); stroke = { pointerId: event.pointerId, last: point, travelled: 0, taps: [point] };
  if (tool === 'similar') applySimilar(point); else stamp(point, imageSize());
  drawCursor(event);
}
function onPointerMove(event: PointerEvent) {
  if (drag) { stage.scrollLeft = drag.left - event.clientX + drag.x; stage.scrollTop = drag.top - event.clientY + drag.y; return; }
  if (!session || moving) return;
  if (!stroke) { if (event.pointerType !== 'touch') drawCursor(event); return; }
  if (event.pointerId !== stroke.pointerId) return;
  if (tool === 'similar') {
    // Dragging adds the colors it passes over that are not switched yet.
    const s = session, spacing = 24 / displayScale;
    for (const sample of event.getCoalescedEvents?.() ?? [event]) {
      const point = toImage(sample), walk = stampsAlong(stroke.last, point, spacing, stroke.travelled);
      for (const p of walk.points) {
        const x = Math.floor(p.x), y = Math.floor(p.y); if (x < 0 || y < 0 || x >= s.source.width || y >= s.source.height) continue;
        const value = s.planes.mask[y * s.source.width + x];
        if ((restore ? value < 128 : value >= 128) && applySimilar(p)) stroke.taps.push(p);
      }
      stroke.last = point; stroke.travelled = walk.travelled;
    }
    drawCursor(event); return;
  }
  // Animals are tried often along the path but only placed where they do not overlap, so each stays readable.
  const size = imageSize(), animal = shape !== 'circle' && restore, spacing = Math.max(1, size * (animal ? 0.25 : SHAPES[shape].spacing));
  for (const sample of event.getCoalescedEvents?.() ?? [event]) {
    const point = toImage(sample), walk = stampsAlong(stroke.last, point, spacing, stroke.travelled);
    for (const p of walk.points) stamp(p, size, animal);
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
  const taps = stroke.taps; stroke = undefined;
  const recorded = session.history.end();
  wand = tool === 'similar' && recorded ? taps : undefined;
  if (wand) status('「似た色の範囲」で、戻す範囲を広げたり狭めたりできます。');
  updateControls();
}

function undo() {
  if (!session || stroke) return; discardExport(); wand = undefined;
  const area = session.history.undo(); if (area) { render(area); status('ひと筆、元に戻しました。'); }
  updateControls();
}
function redo() {
  if (!session || stroke) return; discardExport(); wand = undefined;
  const area = session.history.redo(); if (area) { render(area); status('やり直しました。'); }
  updateControls();
}
function resetAll() {
  if (!session || stroke) return;
  const { planes, history } = session;
  if (!planes.mask.some(v => v !== 0) && !planes.rim.some(v => v !== 0)) { status('すでに全部モノクロです。'); return; }
  discardExport(); wand = undefined; const all = fullRect();
  history.begin(); history.touch(all); planes.mask.fill(0); planes.rim.fill(0); planes.shadow.fill(0); history.end();
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
    composite(s.source.data, s.gray, s.planes, s.source.width, strip, image.data, look);
    c.putImageData(image, strip.x, strip.y);
  }
}
function flushRender() { cancelAnimationFrame(frame); frame = 0; if (dirty) { const area = dirty; dirty = undefined; render(area); } }
function setComparing(value: boolean) {
  if (!session || value === comparing) return;
  if (value) { flushRender(); comparing = true; context().putImageData(session.source, 0, 0); }
  else { comparing = false; render(fullRect()); }
  $('editor-compare').setAttribute('aria-pressed', String(comparing));
}

/** Icon for the similar-color tool: a four-pointed sparkle with a small one beside it. */
function drawSparkle(c: CanvasRenderingContext2D) {
  const star = (x: number, y: number, r: number) => {
    c.beginPath(); c.moveTo(x, y - r);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) c.quadraticCurveTo(x, y, x + dx * r, y + dy * r);
    c.fill();
  };
  star(24, 30, 22); star(45, 13, 9);
}

// --- Brush preview on top of the image ----------------------------------------------------------

function cursorImage(): HTMLCanvasElement {
  const ratio = devicePixelRatio || 1, similar = tool === 'similar', mark: ShapeName = similar ? 'circle' : shape;
  const size = Math.max(4, Math.round((similar ? 22 : imageSize() * displayScale) * ratio)), key = `${mark}:${size}`;
  if (cursorCache?.key === key) return cursorCache.image;
  // Outline only: a dark ring with a light halo stays visible on any photo.
  const pad = 4, image = document.createElement('canvas'); image.width = image.height = size + pad * 2;
  const c = image.getContext('2d')!;
  const ring = (color: string, offset: number) => { c.fillStyle = color; for (const [dx, dy] of [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]) drawShape(c, mark, pad + dx * offset, pad + dy * offset, size); };
  ring('rgba(255,255,255,.95)', 2 * ratio); ring('#1D2B25', ratio);
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000';
  drawShape(c, mark, pad, pad, size);
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
