// Color names are an application rule, not names standardized by OKLCH.
// Conversion: sRGB -> linear RGB -> Oklab (D65), then cylindrical C/h.
export const FAMILY_RULE = {
  version: 'oklch-family-v1', neutralChroma: 0.015,
  blackLightness: 0.25, whiteLightness: 0.90,
  hueBoundaries: [40, 75, 110, 135, 175, 210, 285, 325, 355],
} as const;

export const FAMILIES = [
  { key: 0, label: '赤系', color: [209, 65, 65] },
  { key: 1, label: '橙・茶系', color: [194, 123, 69] },
  { key: 2, label: '黄系', color: [214, 184, 68] },
  { key: 3, label: '黄緑系', color: [139, 167, 67] },
  { key: 4, label: '緑系', color: [61, 139, 94] },
  { key: 5, label: '青緑系', color: [51, 151, 156] },
  { key: 6, label: '青系', color: [79, 122, 183] },
  { key: 7, label: '紫系', color: [146, 103, 186] },
  { key: 8, label: '桃・赤紫系', color: [190, 100, 152] },
  { key: 9, label: '白に近い色', color: [243, 243, 243] },
  { key: 10, label: 'グレー系', color: [145, 145, 145] },
  { key: 11, label: '黒に近い色', color: [38, 38, 38] },
  { key: 12, label: '完全透明', color: [200, 200, 200] },
] as const;
export const EXCLUDED_FAMILY = 255;

const linear = Float64Array.from({ length: 256 }, (_, n) => {
  const c = n / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const R = linear[r], G = linear[g], B = linear[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(a, bb), (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360];
}

export function familyFromOklch(L: number, C: number, h: number): number {
  if (C < FAMILY_RULE.neutralChroma) return L < FAMILY_RULE.blackLightness ? 11 : L >= FAMILY_RULE.whiteLightness ? 9 : 10;
  const hue = (h % 360 + 360) % 360;
  for (let i = 0; i < FAMILY_RULE.hueBoundaries.length; i++) if (hue < FAMILY_RULE.hueBoundaries[i]) return i;
  return 0;
}

export function classifyFamily(r: number, g: number, b: number, alpha = 255): number {
  return alpha === 0 ? 12 : familyFromOklch(...rgbToOklch(r, g, b));
}
