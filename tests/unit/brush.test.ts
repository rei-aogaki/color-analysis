import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStamp, clipRect, composite, luminance, occupiedRatio, stampsAlong, unionRect } from '../../src/editor/mask.ts';
import { MaskHistory } from '../../src/editor/history.ts';
import { selectSimilar, thresholdOf } from '../../src/editor/select.ts';

const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

test('モノクロは線形の明るさで計算し、白・黒・灰色を保つ', () => {
  const gray = luminance(rgba([255,255,255,255], [0,0,0,255], [128,128,128,255], [255,0,0,255], [0,255,0,255], [0,0,255,255]));
  assert.deepEqual([...gray.slice(0, 3)], [255, 0, 128]);
  // Green looks brightest and blue darkest at the same encoded value.
  assert(gray[4] > gray[3] && gray[3] > gray[5], JSON.stringify([...gray]));
  assert.deepEqual([gray[3], gray[4], gray[5]], [127, 220, 76]);
});

const plain = { dim: 0, vivid: 1 };
const planesOf = (mask: number[], rim = mask.map(() => 0), shadow = mask.map(() => 0)) =>
  ({ mask: new Uint8Array(mask), rim: new Uint8Array(rim), shadow: new Uint8Array(shadow) });

test('合成はマスク0でモノクロ、255で元の色、中間で混ざり、透明度は元のまま', () => {
  const source = rgba([200,40,10,255], [200,40,10,128], [200,40,10,255]);
  const gray = new Uint8Array([100, 100, 100]), out = new Uint8ClampedArray(12);
  composite(source, gray, planesOf([0, 255, 128]), 3, { x: 0, y: 0, w: 3, h: 1 }, out, plain);
  assert.deepEqual([...out], [100,100,100,255, 200,40,10,128, 150,70,55,255]);
});

test('見せ方：背景を暗くし、影・白いふちの上に、鮮やかにした色を重ねる', () => {
  const source = rgba([150,100,50,255], [150,100,50,255], [150,100,50,255], [150,100,50,255]);
  const gray = new Uint8Array([100, 100, 100, 100]), out = new Uint8ClampedArray(16);
  // Background only, shadow, rim, and color on top of the rim.
  composite(source, gray, planesOf([0, 0, 0, 255], [0, 0, 255, 255], [0, 255, 255, 255]), 4, { x: 0, y: 0, w: 4, h: 1 }, out, { dim: .5, vivid: 2 });
  assert.deepEqual([...out], [50,50,50,255, 30,30,30,255, 255,255,255,255, 200,100,0,255]);
  // vivid stays within 0–255 and keeps gray pixels gray.
  composite(rgba([250,10,128,255]), new Uint8Array([128]), planesOf([255]), 1, { x: 0, y: 0, w: 1, h: 1 }, out, { dim: 0, vivid: 1.8 });
  assert.deepEqual([...out.slice(0, 4)], [255,0,128,255]);
});

test('重なり判定：形の中で、すでに色やふちがある割合を返す', () => {
  const planes = planesOf([0,0,0, 0,255,0, 0,0,0], [0,0,0, 0,0,0, 0,0,200]);
  const full = new Uint8Array(4).fill(255);
  assert.equal(occupiedRatio(planes, 3, 3, full, 2, 0, 0), .25);
  assert.equal(occupiedRatio(planes, 3, 3, full, 2, 1, 1), .5);
  assert.equal(occupiedRatio(planesOf(new Array(9).fill(0)), 3, 3, full, 2, 0, 0), 0);
  assert.equal(occupiedRatio(planes, 3, 3, full, 2, 5, 5), 1, 'a stamp entirely outside counts as unavailable');
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
  const width = 100, height = 70, mask = new Uint8Array(width * height), rim = new Uint8Array(width * height);
  const history = new MaskHistory([mask, rim], width, height);
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
  history.begin(); history.touch({ x: 0, y: 0, w: 1, h: 1 }); rim[0] = 9; assert.equal(history.end(), true, 'a change in another plane is recorded');
  history.undo(); assert.equal(rim[0], 0); history.redo(); assert.equal(rim[0], 9);
  history.clear(); assert.equal(history.canUndo, false); assert.equal(history.storedBytes, 0);
});

test('履歴はメモリ上限を超えると古い筆から捨て、最新の筆は必ず残す', () => {
  const width = 128, height = 128, mask = new Uint8Array(width * height);
  const history = new MaskHistory([mask], width, height, 64 * 64 * 2 * 2);
  for (const [x, y] of [[0, 0], [64, 0], [0, 64]]) { history.begin(); history.touch({ x, y, w: 1, h: 1 }); mask[y * width + x] = 255; history.end(); }
  assert.equal(history.storedBytes, 64 * 64 * 2 * 2);
  history.undo(); history.undo(); assert.equal(history.canUndo, false);
  assert.equal(mask[0], 255, 'the oldest stroke can no longer be undone');
  const big = new MaskHistory([mask], width, height, 10); big.begin(); big.touch({ x: 0, y: 0, w: 128, h: 128 }); mask.fill(7); big.end();
  assert.equal(big.canUndo, true);
});

test('似た色：つながった所だけ、または画像全体の似た色を選び、ふちを1画素なめらかにする', () => {
  // 7 × 3: red | gray wall | red, with a darker red (shadow) next to the left red.
  const R = [200,30,30,255], S = [120,15,15,255], G = [128,128,128,255];
  const row = [R, S, G, G, G, R, R], width = 7, height = 3;
  const data = new Uint8ClampedArray(Array.from({ length: height }, () => row).flat(2));
  const local = selectSimilar(data, width, height, 0, 1, .5, true)!;
  assert.deepEqual(local.rect, { x: 0, y: 0, w: 3, h: 3 }, 'shaded red joins, the wall stops the fill');
  assert.equal(local.coverage[1 * 3 + 0], 255); assert.equal(local.coverage[1 * 3 + 1], 255);
  assert(local.coverage[1 * 3 + 2] > 0 && local.coverage[1 * 3 + 2] < 255, 'one soft pixel outside');
  const global = selectSimilar(data, width, height, 0, 1, .5, false)!;
  assert.deepEqual(global.rect, { x: 0, y: 0, w: 7, h: 3 }, 'red on the other side is included');
  assert.equal(global.coverage[1 * 7 + 6], 255); assert.equal(global.coverage[1 * 7 + 3], 0);
  const strict = selectSimilar(data, width, height, 0, 1, 0, false)!;
  assert(strict.coverage[1 * strict.rect.w + (1 - strict.rect.x)] < 128, 'low tolerance leaves the shadow out (only the soft edge)');
  assert.equal(selectSimilar(data, width, height, 9, 0, .5, true), undefined);
  const clear = new Uint8ClampedArray(data); clear[3] = 0;
  assert.equal(selectSimilar(clear, width, height, 0, 0, .5, true), undefined, 'transparent seed selects nothing');
  assert(thresholdOf(0) < thresholdOf(1));
});
