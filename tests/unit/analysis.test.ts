import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, hexOf, percent } from '../../src/analysis/histogram.ts';
import { serialize, CSV_COLUMNS } from '../../src/export/serialize.ts';
import type { Options } from '../../src/types.ts';

const fixture = new Uint8ClampedArray([255,0,0,255, 255,0,0,128, 0,0,255,255, 0,0,0,0]);
test('RGBAの全数集計は透明度を区別し、分母・透明度別件数が一致する', async () => {
  const h = await analyzePixels(fixture, 4, 1, { mode: 'exact', match: 'rgba', alphaPolicy: 'exclude-zero' });
  assert.equal(h.summary.includedPixels, 3); assert.equal(h.summary.excludedPixels, 1); assert.equal(h.summary.rowCount, 3);
  assert.deepEqual([h.summary.opaquePixels,h.summary.translucentPixels,h.summary.transparentPixels], [2,1,1]);
  assert.deepEqual(Array.from(h.order, i => hexOf(h.row(i))), ['#0000FFFF','#FF000080','#FF0000FF']);
  assert.equal(h.query({ hex: '#ff0000', sort: 'count-desc', page: 0, pageSize: 50 }).total, 2);
  assert.equal(h.query({ hex: '#FF000080', sort: 'count-desc', page: 0, pageSize: 50 }).rows[0].count, 1);
});
test('RGB一致は半透明と不透明をまとめ、完全透明も選択して含められる', async () => {
  const h = await analyzePixels(fixture, 4, 1, { mode: 'exact', match: 'rgb', alphaPolicy: 'all' });
  assert.equal(h.summary.includedPixels, 4); assert.equal(h.summary.rowCount, 3);
  const red = h.row(h.order[0]); assert.equal(hexOf(red), '#FF0000'); assert.equal(red.count, 2); assert.equal(red.ratio, .5);
});
test('対象0・極小割合・1画素を安全に扱う', async () => {
  const h = await analyzePixels(new Uint8ClampedArray(4), 1, 1, { mode: 'exact', match: 'rgba', alphaPolicy: 'exclude-zero' });
  assert.equal(h.order.length, 0); assert.equal(h.summary.includedPixels, 0);
  assert.equal(h.query({ hex: '', sort: 'count-desc', page: 99, pageSize: 50 }).page, 0);
  assert.equal(percent(1 / 16_000_000), '<0.0001%'); assert.equal(percent(1), '100.0000%');
  assert.deepEqual(JSON.parse(await (await serialize(h, 'json')).text()).rows, []);
  assert.equal((await (await serialize(h, 'csv')).text()).trim(), CSV_COLUMNS.join(','));
});
test('区間の境界と代表色平均を既知値と照合する', async () => {
  const h = await analyzePixels(new Uint8ClampedArray([0,0,0,255, 31,0,0,128, 32,0,0,255, 255,255,255,255]), 4, 1,
    { mode: 'quantized', step: 32, alphaPolicy: 'exclude-zero' });
  assert.equal(h.summary.rowCount, 3); assert.equal(hexOf(h.row(h.order[0])), '#100000');
  assert.equal(h.row(h.order[0]).count, 2); assert.equal(h.row(h.order[0]).alpha, null);
});
test('無効な入力・寸法・色数上限を部分成功にしない', async () => {
  await assert.rejects(analyzePixels(fixture, 3, 1, { mode: 'exact', match: 'rgba', alphaPolicy: 'all' }));
  await assert.rejects(analyzePixels(fixture, 4, 1, { mode: 'quantized', step: 0, alphaPolicy: 'all' } as unknown as Options));
  await assert.rejects(analyzePixels(fixture, 4, 1, { mode: 'exact', match: 'rgba', alphaPolicy: 'all' }, undefined, 2), /上限/);
});
test('CSVとJSONは全行・測定条件を保持し、比率を表示用に丸めない', async () => {
  const h = await analyzePixels(fixture, 4, 1, { mode: 'exact', match: 'rgba', alphaPolicy: 'exclude-zero' });
  const json = JSON.parse(await (await serialize(h, 'json')).text());
  assert.equal(json.rows.reduce((n: number, row: { count: number }) => n + row.count, 0), 3);
  assert.equal(json.rows[0].ratio, 1 / 3); assert.equal(json.schemaVersion, 2); assert.equal(json.rowCount, undefined);
  const csv = await (await serialize(h, 'csv')).text(); const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4); assert.equal(lines[1].split(',').length, CSV_COLUMNS.length);
  assert.equal(Number(lines[1].split(',')[CSV_COLUMNS.indexOf('ratio')]), 1 / 3);
  await assert.rejects(serialize(h, 'json', () => true), /EXPORT_CANCELLED/);
});
test('多色データの集計を独立した参照実装と照合し、検索と並び順を確認する', async () => {
  const data = new Uint8ClampedArray(1024 * 4); const expected = new Map<string, number>();
  for (let i = 0; i < 1024; i++) {
    const values = [i % 256, Math.floor(i / 256), i % 17, [0,1,128,254,255][i % 5]];
    data.set(values, i * 4); if (values[3]) { const key = values.join(','); expected.set(key, (expected.get(key) ?? 0) + 1); }
  }
  const h = await analyzePixels(data, 32, 32, { mode: 'exact', match: 'rgba', alphaPolicy: 'exclude-zero' });
  assert.equal(h.summary.rowCount, expected.size);
  for (const i of h.order) { const row = h.row(i); assert.equal(row.count, expected.get([...row.rgb,row.alpha].join(','))); }
  const q = h.query({ hex: '', sort: 'color-asc', page: 1, pageSize: 50 }); assert.equal(q.rows.length, 50); assert.equal(q.page, 1);
  assert.throws(() => h.query({ hex: '#XYZ', sort: 'count-desc', page: 0, pageSize: 50 }));
});
