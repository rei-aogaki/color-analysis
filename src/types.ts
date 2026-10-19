export type Options =
  | { mode: 'families'; alphaPolicy: 'all' | 'exclude-zero' }
  | { mode: 'exact'; match: 'rgba' | 'rgb'; alphaPolicy: 'all' | 'exclude-zero' }
  | { mode: 'quantized'; step: 16 | 32; alphaPolicy: 'all' | 'exclude-zero' };
export type Row = { key: number; rgb: [number, number, number]; alpha: number | null; count: number; ratio: number; family?: string };
export type Summary = {
  schemaVersion: 2; appVersion: string; measurementBasis: 'canvas-srgb-rgba8';
  classification?: { version: string; neutralChroma: number; blackLightness: number; whiteLightness: number; hueBoundaries: readonly number[] };
  width: number; height: number; options: Options; totalPixels: number;
  includedPixels: number; excludedPixels: number; transparentPixels: number;
  translucentPixels: number; opaquePixels: number; rowCount: number;
};
export type Query = { hex: string; sort: 'count-desc' | 'color-asc'; page: number; pageSize: 50 | 100 | 200 };
export type Request =
  | { type: 'start'; jobId: number; width: number; height: number; buffer: ArrayBuffer; options: Options }
  | { type: 'query'; jobId: number; requestId: number; query: Query }
  | { type: 'export'; jobId: number; requestId: number; format: 'csv' | 'json' }
  | { type: 'cancel-export'; jobId: number };
export type Response =
  | { type: 'progress'; jobId: number; phase: string; percent: number }
  | { type: 'complete'; jobId: number; summary: Summary; top: Row[]; elapsedMs: number; familyLabels?: ArrayBuffer }
  | { type: 'page'; jobId: number; requestId: number; rows: Row[]; total: number; page: number }
  | { type: 'export-ready'; jobId: number; requestId: number; blob: Blob; format: 'csv' | 'json' }
  | { type: 'export-cancelled'; jobId: number; requestId: number }
  | { type: 'error'; jobId: number; requestId?: number; phase: 'analysis' | 'query' | 'export'; message: string };
