import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFamily, EXCLUDED_FAMILY, familyFromOklch, FAMILY_RULE, rgbToOklch } from '../../src/analysis/families.ts';
import { analyzePixels } from '../../src/analysis/histogram.ts';
import { CSV_COLUMNS, serialize } from '../../src/export/serialize.ts';

test('sRGBの既知原色と無彩色をOKLCHで分類する', () => {
  assert.equal(classifyFamily(255,0,0), 0);
  assert.equal(classifyFamily(0,255,0), 4);
  assert.equal(classifyFamily(0,0,255), 6);
  assert.equal(classifyFamily(255,255,0), 2);
  assert.equal(classifyFamily(0,255,255), 5);
  assert.equal(classifyFamily(255,0,255), 8);
  assert.equal(classifyFamily(255,255,255), 9);
  assert.equal(classifyFamily(128,128,128), 10);
  assert.equal(classifyFamily(0,0,0), 11);
  const [L,C] = rgbToOklch(255,255,255); assert(Math.abs(L-1) < 1e-6); assert(C < 1e-6);
});
test('明るさの異なる青・青みのあるくすみ色も青系にまとめる', () => {
  for (const [r,g,b] of [[10,40,90],[110,156,180],[180,210,235],[51,92,129]]) assert.equal(classifyFamily(r,g,b), 6);
});
test('無彩色の閾値・明るさ・色相の境目を明示的に扱う', () => {
  assert.equal(familyFromOklch(.5,.014999,250), 10);
  assert.equal(familyFromOklch(.5,.015,250), 6);
  assert.equal(familyFromOklch(.2499,0,0), 11); assert.equal(familyFromOklch(.25,0,0), 10);
  assert.equal(familyFromOklch(.8999,0,0), 10); assert.equal(familyFromOklch(.9,0,0), 9);
  assert.equal(familyFromOklch(.5,.1,39.999),0); assert.equal(familyFromOklch(.5,.1,40),1);
  assert.equal(familyFromOklch(.5,.1,355),0); assert.equal(familyFromOklch(.5,.1,360),0);
  for (const h of FAMILY_RULE.hueBoundaries) assert(Number.isInteger(familyFromOklch(.5,.1,h)));
});
test('全画素の分類ラベル件数と系統統計が一致し、透明部分を取り違えない', async () => {
  const data = new Uint8ClampedArray([110,156,180,255, 10,40,90,128, 255,0,0,255, 110,156,180,0]);
  for (const alphaPolicy of ['exclude-zero','all'] as const) {
    const h = await analyzePixels(data,4,1,{mode:'families',alphaPolicy});
    assert.equal(h.summary.includedPixels, alphaPolicy === 'all' ? 4 : 3);
    assert.deepEqual(Array.from(h.familyLabels!), [6,6,0,alphaPolicy === 'all' ? 12 : EXCLUDED_FAMILY]);
    assert.equal(h.row(h.order[0]).family,'青系'); assert.equal(h.row(h.order[0]).count,2);
    for (const i of h.order) {
      const row = h.row(i); assert.equal(Array.from(h.familyLabels!).filter(key=>key===row.key).length, row.count);
    }
    if (alphaPolicy === 'all') { const row = Array.from(h.order,i=>h.row(i)).find(row=>row.key===12)!; assert.equal(row.alpha,0); }
    assert.equal(h.summary.classification?.version,'oklch-family-v1');
  }
});
test('系統別出力はルール・名前・全件を保持し、完全一致の色数上限に依存しない', async () => {
  const data = new Uint8ClampedArray(256*4);
  for (let i=0;i<256;i++) data.set([i, i, i, 255],i*4);
  const h = await analyzePixels(data,256,1,{mode:'families',alphaPolicy:'all'},undefined,1);
  assert.equal(h.summary.includedPixels,256); assert.equal(h.summary.rowCount,3);
  const json=JSON.parse(await (await serialize(h,'json')).text());
  assert.equal(json.schemaVersion,2); assert.equal(json.classification.neutralChroma,.015);
  assert.equal(json.rows.reduce((n:number,row:{count:number})=>n+row.count,0),256);
  const csv=(await (await serialize(h,'csv')).text()).trim().split('\r\n');
  assert.equal(csv[1].split(',')[CSV_COLUMNS.indexOf('classificationRule')],'oklch-family-v1');
  assert(csv[1].split(',')[CSV_COLUMNS.indexOf('family')].length>0);
});
