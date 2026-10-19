export const LIMITS = { bytes: 20 * 1024 * 1024, pixels: 16_000_000, side: 8192, elements: 100_000 };
export type ImageHeader = { format: 'PNG' | 'JPEG' | 'WebP'; width: number; height: number; orientation: number };
const invalid = () => new Error('画像の構造が正しくありません。別のPNG・JPEG・WebP画像を選んでください。');
const animated = () => new Error('動く画像には対応していません。静止画のPNG・JPEG・WebPを選んでください。');
const ascii = (data: Uint8Array, offset: number, count: number) => String.fromCharCode(...data.subarray(offset, offset + count));
const u32 = (a: Uint8Array, little = false) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(0, little);

class Reader {
  private start = -1;
  private cache = new Uint8Array(0);
  readonly file: File;
  constructor(file: File) { this.file = file; }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > this.file.size) throw invalid();
    if (offset < this.start || offset + length > this.start + this.cache.length) {
      this.start = offset;
      this.cache = new Uint8Array(await this.file.slice(offset, Math.min(this.file.size, offset + 65536)).arrayBuffer());
    }
    return this.cache.subarray(offset - this.start, offset - this.start + length);
  }
}

function orientationFromExif(data: Uint8Array): number {
  const start = ascii(data, 0, 6) === 'Exif\0\0' ? 6 : 0;
  if (data.length < start + 8) throw invalid();
  const endian = ascii(data, start, 2);
  if (endian !== 'II' && endian !== 'MM') throw invalid();
  const little = endian === 'II', view = new DataView(data.buffer, data.byteOffset + start, data.byteLength - start);
  if (view.getUint16(2, little) !== 42) throw invalid();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset + 2 > view.byteLength) throw invalid();
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 + 4 > view.byteLength) throw invalid();
  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    if (view.getUint16(p, little) === 0x112) {
      if (view.getUint16(p + 2, little) !== 3 || view.getUint32(p + 4, little) !== 1) throw invalid();
      const o = view.getUint16(p + 8, little); if (o < 1 || o > 8) throw invalid(); return o;
    }
  }
  return 1;
}

export function checkDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw invalid();
  if (width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) {
    throw new Error('画像が大きすぎます。1,600万画素以下、縦・横それぞれ8,192px以下の画像を選んでください。自動縮小は行いません。');
  }
}

export async function validateFile(file: File): Promise<ImageHeader> {
  if (!file.size) throw new Error('空のファイルは読み込めません。');
  if (file.size > LIMITS.bytes) throw new Error('容量が20MiBを超えています。小さいファイルを選んでください。');
  const reader = new Reader(file), head = await reader.read(0, Math.min(12, file.size));
  let width = 0, height = 0, orientation = 1, format: ImageHeader['format'];
  let elements = 0;
  const countElement = () => { if (++elements > LIMITS.elements) throw new Error('画像の構造要素が試作の上限を超えています。別の画像を選んでください。'); };
  if ([137,80,78,71,13,10,26,10].every((n, i) => head[i] === n)) {
    format = 'PNG'; let offset = 8, ended = false, hasData = false;
    while (offset < file.size) {
      countElement(); const h = await reader.read(offset, 8), length = u32(h), type = ascii(h, 4, 4);
      if (offset + length + 12 > file.size) throw invalid();
      if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw invalid();
      if (type === 'IHDR') {
        if (offset !== 8 || length !== 13) throw invalid();
        const dimensions = await reader.read(offset + 8, 8); width = u32(dimensions); height = u32(dimensions.subarray(4)); checkDimensions(width, height);
      }
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw animated();
      if (type === 'IDAT') hasData = true;
      if (type === 'eXIf') orientation = orientationFromExif(await reader.read(offset + 8, length));
      offset += length + 12;
      if (type === 'IEND') { if (length !== 0 || offset !== file.size || !hasData) throw invalid(); ended = true; break; }
    }
    if (!ended) throw invalid();
  } else if (head[0] === 0xff && head[1] === 0xd8) {
    format = 'JPEG'; let offset = 2, sawScan = false;
    const tail = await reader.read(file.size - 2, 2);
    if (tail[0] !== 0xff || tail[1] !== 0xd9) throw invalid();
    while (offset < file.size) {
      countElement(); if ((await reader.read(offset++, 1))[0] !== 0xff) throw invalid();
      let marker: number;
      do { marker = (await reader.read(offset++, 1))[0]; countElement(); } while (marker === 0xff);
      if (marker === 0xd9) break;
      if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) throw invalid();
      if (marker === 1) continue;
      const lengthBytes = await reader.read(offset, 2), length = lengthBytes[0] * 256 + lengthBytes[1];
      if (length < 2 || offset + length > file.size) throw invalid();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8 || width) throw invalid();
        const d = await reader.read(offset + 2, 5); height = d[1] * 256 + d[2]; width = d[3] * 256 + d[4]; checkDimensions(width, height);
      }
      if (marker === 0xe1 && length >= 8) {
        const prefix = await reader.read(offset + 2, 6);
        if (ascii(prefix, 0, 6) === 'Exif\0\0') orientation = orientationFromExif(await reader.read(offset + 2, length - 2));
      }
      if (marker === 0xda) { sawScan = true; break; }
      offset += length;
    }
    if (!width || !sawScan) throw invalid();
  } else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    format = 'WebP'; if (u32(head.subarray(4, 8), true) + 8 !== file.size) throw invalid();
    let offset = 12, imageChunks = 0;
    while (offset < file.size) {
      countElement(); const h = await reader.read(offset, 8), type = ascii(h, 0, 4), length = u32(h.subarray(4), true);
      if (offset + 8 + length + length % 2 > file.size) throw invalid();
      if (type === 'ANIM' || type === 'ANMF') throw animated();
      if (type === 'VP8X') {
        if (offset !== 12 || length !== 10) throw invalid();
        const d = await reader.read(offset + 8, 10); if (d[0] & 2) throw animated();
        width = 1 + d[4] + d[5] * 256 + d[6] * 65536; height = 1 + d[7] + d[8] * 256 + d[9] * 65536;
      }
      if (type === 'VP8 ' || type === 'VP8L') {
        imageChunks++;
        const d = await reader.read(offset + 8, Math.min(10, length));
        let w = 0, h = 0;
        if (type === 'VP8 ') {
          if (d.length < 10 || d[3] !== 0x9d || d[4] !== 1 || d[5] !== 0x2a) throw invalid();
          w = (d[6] + d[7] * 256) & 0x3fff; h = (d[8] + d[9] * 256) & 0x3fff;
        } else {
          if (d.length < 5 || d[0] !== 0x2f) throw invalid();
          w = 1 + ((d[1] + d[2] * 256) & 0x3fff); h = 1 + ((d[2] >> 6 | d[3] << 2 | d[4] << 10) & 0x3fff);
        }
        if (width && (width !== w || height !== h)) throw invalid(); width = w; height = h;
      }
      if (type === 'EXIF') orientation = orientationFromExif(await reader.read(offset + 8, length));
      if (width) checkDimensions(width, height);
      offset += 8 + length + length % 2;
    }
    if (imageChunks !== 1 || !width) throw invalid();
  } else throw new Error('対応形式は静止画のPNG・JPEG・WebPです。拡張子の変更だけでは読み込めません。');
  checkDimensions(width, height);
  return { format, width, height, orientation };
}

export async function decode(file: File, header: ImageHeader): Promise<{ bitmap: ImageBitmap; pixels: ImageData }> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'default' }); }
  catch { throw new Error('画像を読み取れませんでした。破損していない別の画像でお試しください。'); }
  try {
    const swaps = header.orientation >= 5;
    if (bitmap.width !== (swaps ? header.height : header.width) || bitmap.height !== (swaps ? header.width : header.height)) throw new Error('画像の向き・寸法が想定と一致しません。この画像は試作で読み込めません。');
    checkDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    try {
      const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      if (!context) throw new Error('このブラウザでは画素を読み取れません。');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
      if (!(pixels.data instanceof Uint8ClampedArray) || pixels.colorSpace !== 'srgb') throw new Error('sRGB・8bitの画素読み取りに対応していません。');
      return { bitmap, pixels };
    } finally { canvas.width = 0; canvas.height = 0; }
  } catch (error) { bitmap.close(); throw error; }
}
