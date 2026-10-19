import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile, checkDimensions } from '../../src/image/read.ts';
import { png, chunk, exifOrientation } from '../fixtures/png.ts';

test('PNGを拡張子・MIMEを信用せず判別する', async () => {
  const file = new File([png(2, 3, () => [0,0,0,255])], 'synthetic.bin');
  assert.deepEqual(await validateFile(file), { format: 'PNG', width: 2, height: 3, orientation: 1 });
});
test('アニメPNG・偽装・切断・過大寸法を復号前に拒否する', async () => {
  await assert.rejects(validateFile(new File([png(1,1,()=>[0,0,0,255],[chunk('acTL',Buffer.alloc(8))])], 'animation.png')), /動く画像/);
  await assert.rejects(validateFile(new File(['<svg></svg>'], 'fake.png', { type: 'image/png' })), /対応形式/);
  const good = png(2,2,()=>[0,0,0,255]); await assert.rejects(validateFile(new File([good.subarray(0,-2)], 'broken.png')));
  assert.throws(() => checkDimensions(8193, 1), /大きすぎ/); assert.throws(() => checkDimensions(4001, 4000), /大きすぎ/);
  assert.doesNotThrow(() => checkDimensions(4000, 4000));
});
test('EXIF向き1〜8と不正な範囲を検証する', async () => {
  for (let o = 1; o <= 8; o++) {
    const f = new File([png(2,3,()=>[0,0,0,255],[chunk('eXIf', exifOrientation(o))])], 'orientation.png');
    assert.equal((await validateFile(f)).orientation, o);
  }
  const bad = exifOrientation(1); bad.writeUInt32LE(65535,4);
  await assert.rejects(validateFile(new File([png(1,1,()=>[0,0,0,255],[chunk('eXIf',bad)])], 'bad.png')));
});
