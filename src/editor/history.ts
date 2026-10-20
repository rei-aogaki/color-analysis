import { unionRect, type Rect } from './mask.ts';

// Undo/redo for the mask, one entry per stroke. Only tiles a stroke touched are stored,
// before and after, so a small stroke on a 16-megapixel image stays small in memory.
const TILE = 64;
type Tile = { rect: Rect; before: Uint8Array; after: Uint8Array };
type Stroke = { tiles: Tile[]; bounds: Rect; bytes: number };

export class MaskHistory {
  private readonly mask: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private readonly limitBytes: number;
  private readonly columns: number;
  private pending: Map<number, { rect: Rect; before: Uint8Array }> | undefined;
  private undoStack: Stroke[] = [];
  private redoStack: Stroke[] = [];
  private bytes = 0;

  constructor(mask: Uint8Array, width: number, height: number, limitBytes = 64 * 1024 * 1024) {
    this.mask = mask; this.width = width; this.height = height; this.limitBytes = limitBytes;
    this.columns = Math.ceil(width / TILE);
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get stroking() { return this.pending !== undefined; }
  get storedBytes() { return this.bytes; }

  begin(): void { this.pending = new Map(); }
  /** Call before the mask changes inside rect, so the previous values can be kept. */
  touch(rect: Rect): void {
    if (!this.pending) return;
    const x0 = Math.floor(rect.x / TILE), y0 = Math.floor(rect.y / TILE);
    const x1 = Math.floor((rect.x + rect.w - 1) / TILE), y1 = Math.floor((rect.y + rect.h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const index = ty * this.columns + tx; if (this.pending.has(index)) continue;
      const x = tx * TILE, y = ty * TILE;
      const tileRect = { x, y, w: Math.min(TILE, this.width - x), h: Math.min(TILE, this.height - y) };
      this.pending.set(index, { rect: tileRect, before: this.read(tileRect) });
    }
  }
  /** Finish the stroke. Returns false when the stroke changed nothing and was not recorded. */
  end(): boolean {
    const pending = this.pending; this.pending = undefined; if (!pending) return false;
    const tiles: Tile[] = []; let bounds: Rect | undefined, bytes = 0;
    for (const { rect, before } of pending.values()) {
      const after = this.read(rect); if (equal(before, after)) continue;
      tiles.push({ rect, before, after }); bytes += before.length * 2;
      bounds = unionRect(bounds, rect);
    }
    if (!bounds) return false;
    this.redoStack = []; this.recount();
    this.undoStack.push({ tiles, bounds, bytes }); this.bytes += bytes;
    // Drop the oldest strokes beyond the memory budget, but always keep the latest one.
    while (this.bytes > this.limitBytes && this.undoStack.length > 1) this.bytes -= this.undoStack.shift()!.bytes;
    return true;
  }
  /** Restores the previous stroke and returns the area to redraw. */
  undo(): Rect | undefined {
    if (this.pending) this.end();
    const stroke = this.undoStack.pop(); if (!stroke) return undefined;
    for (const tile of stroke.tiles) this.write(tile.rect, tile.before);
    this.redoStack.push(stroke); return stroke.bounds;
  }
  redo(): Rect | undefined {
    const stroke = this.redoStack.pop(); if (!stroke) return undefined;
    for (const tile of stroke.tiles) this.write(tile.rect, tile.after);
    this.undoStack.push(stroke); return stroke.bounds;
  }
  clear(): void { this.pending = undefined; this.undoStack = []; this.redoStack = []; this.bytes = 0; }

  private recount() { this.bytes = this.undoStack.reduce((sum, stroke) => sum + stroke.bytes, 0); }
  private read(rect: Rect): Uint8Array {
    const out = new Uint8Array(rect.w * rect.h);
    for (let row = 0; row < rect.h; row++) {
      const start = (rect.y + row) * this.width + rect.x;
      out.set(this.mask.subarray(start, start + rect.w), row * rect.w);
    }
    return out;
  }
  private write(rect: Rect, values: Uint8Array) {
    for (let row = 0; row < rect.h; row++) this.mask.set(values.subarray(row * rect.w, (row + 1) * rect.w), (rect.y + row) * this.width + rect.x);
  }
}

function equal(a: Uint8Array, b: Uint8Array) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
