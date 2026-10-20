import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStamp, clipRect, composite, luminance, stampsAlong, unionRect } from '../../src/editor/mask.ts';
import { MaskHistory } from '../../src/editor/history.ts';

const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

test('モノクロは線形の明るさで計算し、白・黒・灰色を保つ', () => {
  const gray = luminance(rgba([255,255,255,255], [0,0,0,255], [128,128,128,255], [255,0,0,255], [0,255,0,255], [0,0,255,255]));
  assert.deepEqual([...gray.slice(0, 3)], [255, 0, 128]);
  // Green looks brightest and blue darkest at the same encoded value.
  assert(gray[4] > gray[3] && gray[3] > gray[5], JSON.stringify([...gray]));
  assert.deepEqual([gray[3], gray[4], gray[5]], [127, 220, 76]);
});

test('合成はマスク0でモノクロ、255で元の色、中間で混ざり、透明度は元のまま', () => {
  const source = rgba([200,40,10,255], [200,40,10,128], [200,40,10,255]);
  const gray = new Uint8Array([100, 100, 100]), mask = new Uint8Array([0, 255, 128]);
  const out = new Uint8ClampedArray(12);
  composite(source, gray, mask, 3, { x: 0, y: 0, w: 3, h: 1 }, out);
  assert.deepEqual([...out], [100,100,100,255, 200,40,10,128, 150,70,55,255]);
});

test('スタンプは色を戻すと最大値、モノクロに戻すと反転した最小値で書き込む', () => {
  const mask = new Uint8Array(16), coverage = new Uint8Array([0, 255, 128, 255]);
  assert.deepEqual(applyStamp(mask, 4, 4, coverage, 2, 2, 1, 1, true), { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual([...mask], [0,0,0,0, 0,0,255,0, 0,128,255,0, 0,0,0,0]);
  applyStamp(mask, 4, 4, new Uint8Array([64]), 1, 1, 2, 2, true); assert.equal(mask[10], 255);
  applyStamp(mask, 4, 4, new Uint8Array([200]), 1, 1, 2, 2, false); assert.equal(mask[10], 55);
  applyStamp(mask, 4, 4, new Uint8Array([0]), 1, 1, 1, 2, false); assert.equal(mask[9], 128);
});

test('画像の外にはみ出すスタンプは範囲内だけを書き換え、完全に外なら何もしない', () => {
  const mask = new Uint8Array(9), coverage = new Uint8Array(9).fill(255);
  assert.deepEqual(applyStamp(mask, 3, 3, coverage, 3, 3, -2, -2, true), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual([...mask], [255,0,0, 0,0,0, 0,0,0]);
  assert.equal(applyStamp(mask, 3, 3, coverage, 3, 3, 3, 0, true), undefined);
  assert.equal(clipRect({ x: 5, y: 5, w: 2, h: 2 }, 3, 3), undefined);
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 4, y: 2, w: 2, h: 3 }), { x: 0, y: 0, w: 6, h: 5 });
});

test('なぞった道に一定間隔で並べ、区間をまたいでも間隔を保つ', () => {
  const first = stampsAlong({ x: 0, y: 0 }, { x: 25, y: 0 }, 10, 0);
  assert.deepEqual(first.points.map(p => p.x), [10, 20]); assert.equal(first.travelled, 5);
  const second = stampsAlong({ x: 25, y: 0 }, { x: 25, y: 12 }, 10, first.travelled);
  assert.deepEqual(second.points, [{ x: 25, y: 5 }]); assert.equal(second.travelled, 7);
  assert.deepEqual(stampsAlong({ x: 3, y: 3 }, { x: 3, y: 3 }, 10, 4), { points: [], travelled: 4 });
  // Very small spacing is capped so that a long drag cannot create unbounded stamps.
  assert.equal(stampsAlong({ x: 0, y: 0 }, { x: 10, y: 0 }, 0, 0).points.length, 20);
});

test('ひと筆ごとに元に戻す・やり直すができ、新しい筆でやり直し履歴は消える', () => {
  const width = 100, height = 70, mask = new Uint8Array(width * height), history = new MaskHistory(mask, width, height);
  const paint = (x: number, y: number, value: number) => {
    history.begin(); const rect = { x, y, w: 3, h: 3 }; history.touch(rect);
    for (let row = y; row < y + 3; row++) mask.fill(value, row * width + x, row * width + x + 3);
    return history.end();
  };
  assert.equal(paint(62, 62, 255), true); // Crosses tile boundaries at 64 px.
  assert.equal(paint(10, 10, 200), true);
  const afterTwo = mask.slice();
  assert.deepEqual(history.undo(), { x: 0, y: 0, w: 64, h: 64 });
  assert.equal(mask[10 * width + 10], 0); assert.equal(mask[62 * width + 62], 255);
  history.undo(); assert(mask.every(v => v === 0)); assert.equal(history.canUndo, false);
  history.redo(); history.redo(); assert.deepEqual(mask, afterTwo); assert.equal(history.canRedo, false);
  history.undo(); assert.equal(paint(30, 30, 90), true); assert.equal(history.canRedo, false);
  assert.equal(paint(30, 30, 90), false, 'a stroke without changes is not recorded');
  history.clear(); assert.equal(history.canUndo, false); assert.equal(history.storedBytes, 0);
});

test('履歴はメモリ上限を超えると古い筆から捨て、最新の筆は必ず残す', () => {
  const width = 128, height = 128, mask = new Uint8Array(width * height);
  const history = new MaskHistory(mask, width, height, 64 * 64 * 2 * 2);
  for (const [x, y] of [[0, 0], [64, 0], [0, 64]]) { history.begin(); history.touch({ x, y, w: 1, h: 1 }); mask[y * width + x] = 255; history.end(); }
  assert.equal(history.storedBytes, 64 * 64 * 2 * 2);
  history.undo(); history.undo(); assert.equal(history.canUndo, false);
  assert.equal(mask[0], 255, 'the oldest stroke can no longer be undone');
  const big = new MaskHistory(mask, width, height, 10); big.begin(); big.touch({ x: 0, y: 0, w: 128, h: 128 }); mask.fill(7); big.end();
  assert.equal(big.canUndo, true);
});
