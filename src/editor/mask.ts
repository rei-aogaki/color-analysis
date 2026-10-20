// Pixel math for the color restore brush. No DOM access, so it runs under node --test.
// The color mask holds one byte per pixel: 0 shows monochrome, 255 shows the original color.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export const toLinear = new Float64Array(256);
for (let v = 0; v < 256; v++) { const c = v / 255; toLinear[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const LINEAR_STEPS = 4096;
const toEncoded = new Uint8Array(LINEAR_STEPS + 1);
for (let i = 0; i <= LINEAR_STEPS; i++) {
  const c = i / LINEAR_STEPS, e = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  toEncoded[i] = Math.round(Math.min(1, Math.max(0, e)) * 255);
}

/** Monochrome level per pixel: relative luminance in linear light, encoded back to sRGB. */
export function luminance(data: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const y = 0.2126 * toLinear[data[i]] + 0.7152 * toLinear[data[i + 1]] + 0.0722 * toLinear[data[i + 2]];
    out[p] = toEncoded[Math.round(y * LINEAR_STEPS)];
  }
  return out;
}

export function clipRect(rect: Rect, width: number, height: number): Rect | undefined {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.w), bottom = Math.min(height, rect.y + rect.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}
export function unionRect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Apply a stamp's coverage (one byte per pixel, cw × ch) at left/top.
 * Restoring raises the mask to the coverage; erasing lowers it to 255 - coverage.
 * Returns the clipped rectangle the stamp touched, or undefined when it is off the image.
 */
export function applyStamp(mask: Uint8Array, width: number, height: number, coverage: Uint8Array, cw: number, ch: number,
  left: number, top: number, restore: boolean): Rect | undefined {
  const rect = clipRect({ x: left, y: top, w: cw, h: ch }, width, height); if (!rect) return undefined;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    let m = y * width + rect.x, c = (y - top) * cw + (rect.x - left);
    for (let x = 0; x < rect.w; x++, m++, c++) {
      const value = coverage[c]; if (!value) continue;
      if (restore) { if (value > mask[m]) mask[m] = value; }
      else { const limit = 255 - value; if (limit < mask[m]) mask[m] = limit; }
    }
  }
  return rect;
}

/**
 * How the edit is shown. dim darkens the monochrome background (0–1); vivid scales the
 * restored color's distance from its gray (1 = original color).
 */
export type Look = { dim: number; vivid: number };
/** One byte per pixel each: restored color, white sticker rim, and the rim's drop shadow. */
export type Planes = { mask: Uint8Array; rim: Uint8Array; shadow: Uint8Array };
const SHADOW_STRENGTH = 0.4;

/**
 * Layer, bottom to top: monochrome (dimmed) → shadow → white rim → restored color.
 * out receives rect.w × rect.h RGBA pixels; alpha always follows the source.
 */
export function composite(source: Uint8ClampedArray, gray: Uint8Array, planes: Planes, width: number, rect: Rect, out: Uint8ClampedArray, look: Look): void {
  const { mask, rim, shadow } = planes, keep = 1 - look.dim, vivid = look.vivid;
  let o = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    let p = y * width + rect.x;
    for (let x = 0; x < rect.w; x++, p++, o += 4) {
      const i = p * 4, g = gray[p], m = mask[p];
      let base = g * keep;
      if (shadow[p]) base *= 1 - SHADOW_STRENGTH * shadow[p] / 255;
      if (rim[p]) base += (255 - base) * rim[p] / 255;
      if (m === 0) { out[o] = out[o + 1] = out[o + 2] = base; }
      else {
        let r = source[i], gr = source[i + 1], b = source[i + 2];
        if (vivid !== 1) {
          r = Math.min(255, Math.max(0, g + (r - g) * vivid));
          gr = Math.min(255, Math.max(0, g + (gr - g) * vivid));
          b = Math.min(255, Math.max(0, g + (b - g) * vivid));
        }
        if (m === 255) { out[o] = r; out[o + 1] = gr; out[o + 2] = b; }
        else { out[o] = base + (r - base) * m / 255; out[o + 1] = base + (gr - base) * m / 255; out[o + 2] = base + (b - base) * m / 255; }
      }
      out[o + 3] = source[i + 3];
    }
  }
}

/** Share of the stamp's solid pixels that already show color or a sticker rim. */
export function occupiedRatio(planes: Planes, width: number, height: number, coverage: Uint8Array, size: number, left: number, top: number): number {
  let solid = 0, taken = 0;
  for (let cy = 0; cy < size; cy++) {
    const y = top + cy; if (y < 0 || y >= height) continue;
    for (let cx = 0; cx < size; cx++) {
      const x = left + cx; if (x < 0 || x >= width || coverage[cy * size + cx] < 128) continue;
      solid++; const p = y * width + x; if (planes.mask[p] > 32 || planes.rim[p] > 32) taken++;
    }
  }
  return solid ? taken / solid : 1;
}

/**
 * Stamp positions along a segment, spaced evenly and continuing from the previous segment.
 * travelled is the distance since the last stamp; the returned value carries into the next call.
 */
export function stampsAlong(from: Point, to: Point, spacing: number, travelled: number): { points: Point[]; travelled: number } {
  const step = Math.max(0.5, spacing), dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  const points: Point[] = [];
  if (!length) return { points, travelled };
  let at = step - travelled;
  for (; at <= length; at += step) points.push({ x: from.x + dx * at / length, y: from.y + dy * at / length });
  return { points, travelled: length - (at - step) };
}
