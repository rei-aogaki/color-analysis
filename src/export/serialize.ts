import { hexOf, yieldTask } from '../analysis/histogram.ts';
import type { Histogram } from '../analysis/histogram.ts';

export const CSV_COLUMNS = ['schemaVersion','appVersion','measurementBasis','width','height','mode','alphaPolicy','match','step','totalPixels','includedPixels','excludedPixels','transparentPixels','translucentPixels','opaquePixels','key','hex','r','g','b','alpha','count','ratio','family','classificationRule'];

export async function serialize(histogram: Histogram, format: 'csv' | 'json', cancelled: () => boolean = () => false): Promise<Blob> {
  const { summary: s } = histogram;
  const { rowCount: _rowCount, ...metadata } = s;
  const parts: string[] = [];
  let chunk = format === 'json' ? JSON.stringify(metadata).slice(0, -1) + ',"rows":[' : '\uFEFF' + CSV_COLUMNS.join(',') + '\r\n';
  for (let i = 0; i < histogram.order.length; i++) {
    if (cancelled()) throw new Error('EXPORT_CANCELLED');
    const row = histogram.row(histogram.order[i]);
    if (format === 'json') chunk += (i ? ',' : '') + JSON.stringify(row);
    else chunk += [s.schemaVersion,s.appVersion,s.measurementBasis,s.width,s.height,s.options.mode,s.options.alphaPolicy,
      s.options.mode === 'exact' ? s.options.match : '',s.options.mode === 'quantized' ? s.options.step : '',
      s.totalPixels,s.includedPixels,s.excludedPixels,s.transparentPixels,s.translucentPixels,s.opaquePixels,
      row.key,hexOf(row),...row.rgb,row.alpha ?? '',row.count,row.ratio,row.family ?? '',s.classification?.version ?? ''].join(',') + '\r\n';
    if (i % 2048 === 2047) { parts.push(chunk); chunk = ''; await yieldTask(); }
  }
  if (cancelled()) throw new Error('EXPORT_CANCELLED');
  parts.push(chunk + (format === 'json' ? ']}' : ''));
  return new Blob(parts, { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
}
