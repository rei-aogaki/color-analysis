import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { png, chunk, exifOrientation } from '../fixtures/png.ts';
import { luminance } from '../../src/editor/mask.ts';

const dist = new URL('../../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('asset-manifest.json', dist), 'utf8'));
let server;
let baseURL = process.env.TEST_BASE_URL;
if (!baseURL) {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const name = path === '/color-analysis/' ? 'index.html' : path.startsWith('/color-analysis/') ? path.slice(16) : '';
    if (req.method !== 'GET' || !manifest.includes(name)) { res.writeHead(404).end(); return; }
    try {
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type + ';charset=utf-8' }); res.end(await readFile(new URL(name, dist)));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/color-analysis/`;
}
const output = new URL('../../.local/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined }).catch(error => { server?.close(); throw error; });
const errors = [], requests = [], results = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const openPanel = async (target, id) => {
  if (await target.locator(`#${id}`).getAttribute("open") === null) await target.locator(`#${id} > summary`).click();
};
const upload = async (bytes, name = 'synthetic.png', mimeType = 'image/png', analysisMode = 'exact') => {
  await page.locator('#file').setInputFiles({ name, mimeType, buffer: bytes });
  await page.locator('#analyze').waitFor();
  await page.waitForFunction(() => !document.querySelector('#analyze').disabled);
  await page.locator('#mode').selectOption(analysisMode);
  await page.locator('#advanced-settings > summary').click();
};
const analyze = async () => {
  await openPanel(page, 'analysis-options'); await page.locator('#analyze').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('解析が完了'));
  await page.waitForFunction(() => document.querySelector('#rows').children.length > 0);
};
const download = async format => {
  await page.locator(`#${format}`).click();
  await page.locator('#download').waitFor({ state: 'visible' });
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  const file = await waiting; const chunks = [];
  for await (const part of await file.createReadStream()) chunks.push(part);
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
};
try {
  await page.goto(baseURL); await page.locator('#sample').waitFor();
  assert.equal(await page.locator('#mode').inputValue(), 'families');
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.screenshot({ path: fileURLToPath(new URL('desktop-empty.png', output)), fullPage: true });
  await page.locator('#sample').click();
  await page.waitForFunction(() => !document.querySelector('#analyze').disabled);
  await analyze(); assert.equal(await page.locator('#total').innerText(), '960,000');
  assert.equal(await page.locator('#dominant-name').innerText(), '白に近い色');
  assert.equal(await page.locator('#analysis-options').getAttribute('open'), null);
  assert.equal(await page.locator('#advanced-settings').getAttribute('open'), null);
  assert.equal(await page.locator('#pixel-tools').getAttribute('open'), null);
  assert.equal(await page.locator('#table-details').getAttribute('open'), null);
  await page.screenshot({ path: fileURLToPath(new URL('desktop-results.png', output)), fullPage: true });
  assert(await page.evaluate(() => document.querySelector('#preview').getBoundingClientRect().height <= document.querySelector('#viewport').clientHeight - 30), 'fit preview cropped');
  const sample = JSON.parse(await download('json')); assert.equal(sample.rows.reduce((sum, row) => sum + row.count, 0), 960000);
  assert.equal(await page.locator('#dominant-ratio').innerText(), (sample.rows[0].ratio * 100).toFixed(2));
  assert.equal(await page.locator('#family-buttons > button').first().getAttribute('data-family'), String(sample.rows[0].key));
  await page.locator('.unused-families > summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.unused-families button:disabled').count(), 6);
  await page.keyboard.press('Enter');
  assert.equal(sample.classification.version, 'oklch-family-v1');
  assert.equal(await page.locator('#family-buttons button').count(), 12);
  assert(!(await page.locator('#chart').innerText()).includes('その他'));
  await page.locator('[data-family="6"]').click();
  await page.waitForFunction(()=>document.querySelector('#mask-status').textContent.includes('青系の場所を表示中'));
  const selected = await page.evaluate(()=> {
    const c=document.querySelector('#preview').getContext('2d');
    return { dimmed: Array.from(c.getImageData(100,100,1,1).data), blue: Array.from(c.getImageData(1000,100,1,1).data) };
  });
  assert.deepEqual(selected.dimmed,[35,35,35,230]); assert.deepEqual(selected.blue,[51,92,129,255]);
  assert.equal((await download('json')), JSON.stringify(sample));
  await page.screenshot({ path: fileURLToPath(new URL('family-blue.png',output)),fullPage:true });
  await page.locator('#reset-family').click(); assert.equal(await page.locator('#mask-status').isVisible(), false);
  const restored = await page.evaluate(()=>Array.from(document.querySelector('#preview').getContext('2d').getImageData(100,100,1,1).data));
  assert.deepEqual(restored,[236,232,223,255]);
  results.push('default color families, all categories without Other, exact matching mask, exports unchanged by selection');
  results.push('sample flow, complete counts, JSON download');

  // Color restore editor on the sample (1200 × 800): paint, shapes, erase, undo/redo, compare, save, close/reopen.
  const sampleGray = luminance(new Uint8ClampedArray([236,232,223,255, 212,135,114,255, 51,92,129,255]));
  const editorPixel = (x, y) => page.evaluate(([x, y]) => Array.from(document.querySelector('#editor-canvas').getContext('2d').getImageData(x, y, 1, 1).data), [x, y]);
  const toScreen = async (x, y) => { const box = await page.locator('#editor-canvas').boundingBox(); return [box.x + x / 1200 * box.width, box.y + y / 800 * box.height]; };
  const tapImage = async (x, y) => { const [sx, sy] = await toScreen(x, y); await page.mouse.click(sx, sy); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const brushSize = async () => Number((await page.locator('#editor-size-value').innerText()).replace(/\D/g, ''));
  const plainLook = async target => { await target.evaluate(() => {
    for (const [id, value] of [['editor-vivid', '0'], ['editor-dim', '0']]) { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input')); }
    const sticker = document.getElementById('editor-sticker'); sticker.checked = false; sticker.dispatchEvent(new Event('change'));
  }); await target.evaluate(() => new Promise(requestAnimationFrame)); };
  await page.locator('#open-editor').click();
  assert(await page.locator('#editor').isVisible());
  assert.deepEqual(await page.evaluate(() => ({ open: document.documentElement.classList.contains('editor-open'), inert: document.querySelector('main').inert, focus: document.activeElement.id })),
    { open: true, inert: true, focus: 'editor-close' });
  assert.equal(await page.locator('#editor-look').getAttribute('open'), '', 'look settings are open on wide screens');
  assert.equal(await page.locator('#editor-sticker').isChecked(), true, 'sticker look is on by default');
  // Pixel checks below use the plain look: original colors, no dimming, no rims.
  await plainLook(page);
  assert.equal(await page.locator('[data-shape="similar"]').getAttribute('aria-pressed'), 'true', 'similar color is the default tool');
  assert.equal(await page.locator('#editor-size-row').isVisible(), false);
  await page.locator('[data-shape="circle"]').click(); assert.equal(await page.locator('#editor-size-row').isVisible(), true);
  assert.deepEqual(await editorPixel(360, 320), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'editor starts monochrome');
  assert.equal(await page.locator('#editor-undo').isDisabled(), true);
  await tapImage(360, 320); assert.deepEqual(await editorPixel(360, 320), [212,135,114,255], 'tap restores the original color');
  const [fromX, fromY] = await toScreen(80, 100), [toX, toY] = await toScreen(640, 100);
  await page.mouse.move(fromX, fromY); await page.mouse.down(); await page.mouse.move(toX, toY, { steps: 12 }); await page.mouse.up();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await editorPixel(350, 100), [236,232,223,255], 'a drag restores a continuous line');
  await page.locator('#editor-undo').click(); assert.deepEqual(await editorPixel(350, 100), [sampleGray[0], sampleGray[0], sampleGray[0], 255]);
  assert.deepEqual(await editorPixel(360, 320), [212,135,114,255], 'undo removes one stroke only');
  await page.keyboard.press('Control+Shift+Z'); assert.deepEqual(await editorPixel(350, 100), [236,232,223,255]);
  await page.locator('#editor-erase').click(); await tapImage(360, 320);
  assert.deepEqual(await editorPixel(360, 320), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'erase returns to monochrome');
  await page.keyboard.press('Control+Z'); assert.deepEqual(await editorPixel(360, 320), [212,135,114,255]);
  await page.locator('#editor-restore').click(); await page.locator('[data-shape="bear"]').click();
  assert.equal(await page.locator('[data-shape="bear"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#editor-size').fill('80'); const bear = await brushSize(); assert(bear > 80, String(bear)); await tapImage(960, 640);
  const eye = [Math.round(960 - bear * .13), Math.round(640 + bear * .04)];
  assert.deepEqual(await editorPixel(960, 640), [212,135,114,255], 'bear body restores color');
  assert.deepEqual(await editorPixel(...eye), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'bear eyes keep the monochrome photo');
  await page.locator('#editor-compare').hover(); await page.mouse.down();
  assert.deepEqual(await editorPixel(...eye), [212,135,114,255], 'holding compare shows the original');
  assert.equal(await page.locator('#editor-compare').getAttribute('aria-pressed'), 'true');
  await page.mouse.up(); assert.deepEqual(await editorPixel(...eye), [sampleGray[1], sampleGray[1], sampleGray[1], 255]);
  // Sticker look: a white rim below the bear's chin, a darker background, and more vivid color.
  await page.locator('#editor-sticker').check(); await tapImage(300, 520);
  assert.deepEqual(await editorPixel(300, 520), [236,232,223,255], 'stamp center restores color');
  const rimPixel = await editorPixel(300, Math.round(520 + bear * .455));
  assert(rimPixel.slice(0, 3).every(v => v >= 235), `sticker rim is white: ${rimPixel}`);
  await page.locator('#editor-dim').fill('100'); await page.evaluate(() => new Promise(requestAnimationFrame));
  const dimmed = await editorPixel(1100, 60);
  assert(Math.abs(dimmed[0] - Math.round(sampleGray[2] * .4)) <= 1 && dimmed[0] === dimmed[2], `background dims: ${dimmed}`);
  await page.locator('#editor-vivid').fill('100'); await page.evaluate(() => new Promise(requestAnimationFrame));
  const vivid = await editorPixel(960, 640);
  assert(vivid[0] - vivid[2] > 212 - 114, `restored color gets more vivid: ${vivid}`);
  await page.screenshot({ path: fileURLToPath(new URL('editor-sticker.png', output)) });
  await page.keyboard.press('Control+Z'); await plainLook(page);
  assert.deepEqual(await editorPixel(300, 520), [sampleGray[0], sampleGray[0], sampleGray[0], 255], 'undo removes the sticker');
  // Similar color: one tap restores every area of that color; the range and "connected only" update it live.
  await page.locator('#editor-reset').click(); await page.locator('[data-shape="similar"]').click();
  await page.locator('#editor-tolerance').fill('40'); await tapImage(360, 320);
  assert.deepEqual(await editorPixel(360, 320), [212,135,114,255]); assert.deepEqual(await editorPixel(1000, 700), [212,135,114,255], 'same color elsewhere is restored');
  assert.deepEqual(await editorPixel(100, 100), [sampleGray[0], sampleGray[0], sampleGray[0], 255], 'other colors stay monochrome');
  await page.locator('#editor-connected').check(); await page.evaluate(() => new Promise(requestAnimationFrame)); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await editorPixel(1000, 700), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'connected only drops the separate area');
  assert.deepEqual(await editorPixel(360, 320), [212,135,114,255]);
  await page.locator('#editor-connected').uncheck(); await page.locator('#editor-tolerance').fill('100');
  await page.evaluate(() => new Promise(requestAnimationFrame)); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.notDeepEqual(await editorPixel(100, 100), [sampleGray[0], sampleGray[0], sampleGray[0], 255], 'a wide range reaches related colors');
  await page.locator('#editor-undo').click();
  assert.deepEqual(await editorPixel(360, 320), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'live updates stay a single undo step');
  assert.equal(await page.locator('#editor-undo').isDisabled(), false, 'reset all remains undoable');
  await page.locator('#editor-undo').click(); assert.deepEqual(await editorPixel(960, 640), [212,135,114,255]);
  await page.locator('#editor-tolerance').fill('40'); await page.locator('[data-shape="circle"]').click();
  await page.screenshot({ path: fileURLToPath(new URL('editor-desktop.png', output)) });
  await page.locator('#editor-save').click(); await page.locator('#editor-export').waitFor({ state: 'visible' });
  const savedWaiting = page.waitForEvent('download'); await page.locator('#editor-download').click(); const saved = await savedWaiting;
  assert.equal(saved.suggestedFilename(), 'color-analysis-brush.png');
  const savedBytes = []; for await (const part of await saved.createReadStream()) savedBytes.push(part);
  const savedCheck = await page.evaluate(async ([base64, points]) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const x = c.getContext('2d'); x.drawImage(bitmap, 0, 0);
    const live = document.querySelector('#editor-canvas').getContext('2d');
    return { width: bitmap.width, height: bitmap.height, same: points.every(([px, py]) => x.getImageData(px, py, 1, 1).data.join() === live.getImageData(px, py, 1, 1).data.join()) };
  }, [Buffer.concat(savedBytes).toString('base64'), [[360, 320], [350, 100], [960, 640], eye, [5, 790], [1195, 5]]]);
  assert.deepEqual(savedCheck, { width: 1200, height: 800, same: true }, 'saved PNG matches the edited image at full size');
  await tapImage(200, 700); assert.equal(await page.locator('#editor-export').isVisible(), false, 'a new stroke invalidates the prepared file');
  await page.locator('#editor-reset').click(); assert.deepEqual(await editorPixel(960, 640), [sampleGray[1], sampleGray[1], sampleGray[1], 255]);
  await page.locator('#editor-undo').click(); assert.deepEqual(await editorPixel(960, 640), [212,135,114,255], 'reset all can be undone');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert(await page.evaluate(() => !document.querySelector('main').inert && document.activeElement.id === 'open-editor'));
  assert.equal(await download('json'), JSON.stringify(sample), 'editing leaves analysis results unchanged');
  await page.locator('#open-editor').click(); assert.deepEqual(await editorPixel(360, 320), [212,135,114,255], 'reopening keeps the edit');
  await page.locator('#editor-close').click(); await page.locator('#clear').click();
  await page.locator('#sample').click(); await page.waitForFunction(() => !document.querySelector('#open-editor').disabled);
  await page.locator('#open-editor').click(); assert.deepEqual(await editorPixel(360, 320), [sampleGray[1], sampleGray[1], sampleGray[1], 255], 'clear discards the edit');
  await page.locator('#editor-close').click();
  results.push('color restore editor: tap/drag restore, erase, bear holes, undo/redo/reset, compare, full-size PNG save, close/reopen, clear discards');

  const familyPalette = [[255,0,0,255],[255,128,0,255],[255,255,0,255],[180,240,70,255],[0,255,0,255],
    [0,255,255,255],[0,0,255,255],[128,0,255,255],[255,0,255,255],[255,255,255,255],[128,128,128,255],[0,0,0,255],[0,0,0,0]];
  await upload(png(13,1,x=>familyPalette[x]),'family-fixture.png','image/png','families');
  await openPanel(page, 'analysis-options'); await page.locator('#include-transparent').check(); await analyze();
  const allFamilies = JSON.parse(await download('json'));
  assert.equal(allFamilies.rows.length,13); assert.equal(allFamilies.rows.reduce((n,row)=>n+row.count,0),13);
  assert(!(await page.locator('#chart').innerText()).includes('その他'));
  await page.locator('[data-family="12"]').click();
  await page.waitForFunction(()=>document.querySelector('#mask-status').textContent.includes('完全透明の場所を青で表示中'));
  const transparentMask = await page.evaluate(()=>Array.from(document.querySelector('#preview').getContext('2d').getImageData(12,0,1,1).data));
  assert.deepEqual(transparentMask,[36,88,223,255]);
  await upload(png(100,16,(x,y)=>x<80?[80+x%20,140+y%10,200,255]:[255,0,0,255]),'blue-gradient.png','image/png','families'); await analyze();
  const gradient = JSON.parse(await download('json'));
  assert.equal(gradient.rows.find(row=>row.family==='青系').ratio,.8);
  assert.equal(gradient.rows.reduce((n,row)=>n+row.count,0),1600);
  await page.locator('[data-family="6"]').click(); await page.locator('[data-family="0"]').click(); await page.locator('#reset-family').click();
  assert.equal(await page.locator('#mask-status').isVisible(),false);
  await page.locator('[data-family="6"]').click(); await page.locator('#clear').click();
  await page.waitForFunction(()=>document.querySelector('#preview').width===0 && document.querySelector('#family-buttons').children.length===0);
  results.push('all 13 categories shown, transparent category mask, many blue codes aggregate to 80%, selection races cleared');

  const fixture = png(4, 1, x => [[255,0,0,255],[255,0,0,128],[0,0,255,255],[42,99,11,0]][x]);
  await upload(fixture, 'not-a-real-photo.png'); await analyze();
  assert.equal(await page.locator('#included').innerText(), '3'); assert.equal(await page.locator('#excluded').innerText(), '1');
  assert.equal(await page.locator('#color-count').innerText(), '3');
  const exact = JSON.parse(await download('json'));
  assert.deepEqual(exact.rows.map(row => row.count), [1,1,1]);
  assert(!JSON.stringify(exact).includes('not-a-real-photo'));
  await page.locator('#table-details > summary').click();
  await page.locator('#search').fill('#FF0000');
  await page.waitForFunction(() => document.querySelector('#page-info').textContent.includes('/ 2件'));
  assert.equal(await page.locator('#included').innerText(), '3');
  assert.equal(JSON.parse(await download('json')).rows.length, 3);
  await page.locator('#search').fill('#INVALID');
  await page.waitForFunction(() => document.querySelector('#search-help').textContent.includes('入力してください'));
  await page.locator('#search').fill('');
  await openPanel(page, 'analysis-options'); await page.locator('#match').selectOption('rgb'); assert.equal(await page.locator('#results').isVisible(), false);
  await analyze(); const rgb = JSON.parse(await download('json'));
  assert.equal(rgb.rows.find(row => row.rgb[0] === 255).count, 2);
  await openPanel(page, 'analysis-options'); await page.locator('#include-transparent').check(); await analyze(); assert.equal(await page.locator('#included').innerText(), '4');
  const csv = await download('csv'); assert.equal(csv.trim().split('\r\n').length, 4); assert(!csv.includes('not-a-real-photo'));
  await page.locator('#pixel-tools > summary').click();
  await page.locator('#pixel-x').fill('2'); await page.locator('#pixel-y').fill('0'); await page.locator('#inspect').click();
  assert.equal(await page.locator('#pixel-hex').innerText(), '#0000FFFF');
  await page.locator('#preview').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#pixel-hex').innerText(), '#FF000080');
  results.push('known RGBA/RGB, transparency, pixel coordinates, search, CSV/JSON');

  await upload(png(2,1, x => [x ? 31 : 0,0,0,255])); await page.locator('#mode').selectOption('quantized'); await analyze();
  const quantized = JSON.parse(await download('json')); assert.equal(quantized.rows.length, 1); assert.deepEqual(quantized.rows[0].rgb, [16,0,0]);
  await upload(png(1,1,()=>[0,0,0,0])); await analyze(); const empty = JSON.parse(await download('json'));
  assert.equal(empty.includedPixels, 0); assert.deepEqual(empty.rows, []);
  assert.equal((await download('csv')).trim().split('\r\n').length, 1);
  results.push('quantized representative, empty result and export');

  // Generate JPEG/WebP entirely in the browser, not from a user file.
  for (const type of ['image/jpeg', 'image/webp']) {
    const bytes = await page.evaluate(async type => {
      const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 5;
      const c = canvas.getContext('2d'); c.fillStyle = '#335C81'; c.fillRect(0,0,7,5);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, type);
    await upload(Buffer.from(bytes), `synthetic.${type === 'image/jpeg' ? 'jpg' : 'webp'}`, type); await analyze();
    assert.equal(await page.locator('#total').innerText(), '35');
  }
  const orientations = [];
  const topLeft = ['#000000FF','#C80000FF','#C8C800FF','#00C800FF','#000000FF','#00C800FF','#C8C800FF','#C80000FF'];
  for (let orientation = 1; orientation <= 8; orientation++) {
    await upload(png(2,3, (x,y)=>[x*200,y*100,0,255], [chunk('eXIf',exifOrientation(orientation))]));
    await analyze(); const json = JSON.parse(await download('json'));
    assert.equal(json.width, orientation >= 5 ? 3 : 2); assert.equal(json.height, orientation >= 5 ? 2 : 3);
    await page.locator('#pixel-tools > summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#pixel-hex').innerText(), topLeft[orientation - 1], `orientation ${orientation} top-left`);
    orientations.push(orientation);
  }
  results.push('JPEG/WebP decode; PNG EXIF dimensions and top-left pixel 1–8');

  const animated = png(1,1,()=>[0,0,0,255],[chunk('acTL',Buffer.alloc(8))]);
  await page.locator('#file').setInputFiles({ name: 'animated.png', mimeType: 'image/png', buffer: animated });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('動く画像'));
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.locator('#file').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('対応形式'));
  results.push('animation and format spoof rejected');

  const layouts = [];
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.locator('#sample').click();
    await page.waitForFunction(() => !document.querySelector('#analyze').disabled); await analyze();
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      imageTop: document.querySelector('.image-panel').getBoundingClientRect().top,
      settingsTop: document.querySelector('.settings-panel').getBoundingClientRect().top }));
    assert(layout.scrollWidth <= width, `page overflow at ${width}: ${layout.scrollWidth}`);
    if (width < 900) assert(layout.settingsTop > layout.imageTop);
    layouts.push(layout);
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('mobile-results.png', output)), fullPage: true });
    for (const id of ['analysis-options', 'advanced-settings', 'pixel-tools', 'table-details']) await openPanel(page, id);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `expanded tools overflow at ${width}`);
    await download('json');
  }
  results.push('responsive layouts 1440/768/390/320px, exports after resize');

  // Frame geometry follows the image, while zoom and analysis retain the source pixels.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [w, h] of [[400, 800], [1200, 300], [600, 600], [1, 1]]) {
      await upload(png(w,h,()=>[51,92,129,255]), 'synthetic-shape.png', 'image/png', 'families'); await analyze();
      const geometry = await page.evaluate(() => {
        const frame = document.querySelector('#viewport'), image = document.querySelector('#preview');
        const box = image.getBoundingClientRect();
        return { fw: frame.clientWidth, fh: frame.clientHeight, iw: box.width, ih: box.height,
          column: frame.parentElement.clientWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(!geometry.overflow); assert(geometry.fw <= geometry.column);
      assert(geometry.fh <= 648); assert(geometry.iw <= geometry.fw - 39); assert(geometry.ih <= geometry.fh - 39);
      assert(Math.abs(geometry.iw / geometry.ih - w / h) < .01);
      if (w === 400 && width === 1440) { assert(geometry.fw < geometry.column * .6); assert(geometry.ih > 500); }
      if (w > 1) {
        assert(geometry.fw - geometry.iw < 42 || geometry.fw === 160, JSON.stringify(geometry));
        assert(geometry.fh - geometry.ih < 42 || geometry.fh === 160, JSON.stringify(geometry));
      }
      if (w === 400) {
        // Mobile address bars change innerHeight during scrolling while svh stays fixed; the frame must not resize.
        const toolbarResize = await page.evaluate(() => {
          const frame = document.querySelector('#viewport'), size = () => [frame.clientWidth, frame.clientHeight];
          const original = Object.getOwnPropertyDescriptor(window, 'innerHeight'), start = size(), sizes = [];
          try {
            for (const height of [500, 780, 640]) {
              Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
              dispatchEvent(new Event('resize')); sizes.push(size());
            }
          } finally { if (original) Object.defineProperty(window, 'innerHeight', original); else delete window.innerHeight; dispatchEvent(new Event('resize')); }
          return { start, sizes };
        });
        for (const size of toolbarResize.sizes) assert.deepEqual(size, toolbarResize.start, `frame resized with innerHeight: ${JSON.stringify(toolbarResize)}`);
        const before = await download('json');
        await openPanel(page, 'pixel-tools'); await page.locator('#zoom').selectOption('4');
        assert.equal(await page.locator('#viewport').evaluate(e=>e.clientWidth), geometry.fw);
        await page.getByRole('button', { name: '画像を右へ移動', exact: true }).click();
        assert(await page.locator('#viewport').evaluate(e=>e.scrollLeft > 0));
        await page.locator('#zoom').selectOption('fit');
        const restored = await page.locator('#preview').boundingBox();
        assert(Math.abs(restored.width - geometry.iw) < 1 && Math.abs(restored.height - geometry.ih) < 1);
        assert.equal(await download('json'), before);
        await page.screenshot({ path: fileURLToPath(new URL(`portrait-${width}.png`, output)), fullPage: true });
      }
    }
  }
  results.push('adaptive portrait/landscape/square/tiny frames at desktop and mobile widths, zoom/pan and unchanged full-pixel exports');
  results.push('preview frame keeps its size when only innerHeight changes (mobile address bar)');

  // Use the real compiled Worker, and measure processing only (not image decoding).
  const assets = await readdir(new URL('../../dist/assets/', import.meta.url));
  const workerAsset = assets.find(name => name.startsWith('analysis.worker-') && name.endsWith('.js'));
  const measurements = await page.evaluate(async url => {
    async function measure(side, unique, mode = 'exact') {
      const worker = new Worker(url, { type: 'module' });
      const bytes = new Uint8ClampedArray(side * side * 4);
      for (let i = 0; i < side * side; i++) {
        const value = unique ? i : i % 4; bytes[i*4] = value >>> 16 & 255; bytes[i*4+1] = value >>> 8 & 255; bytes[i*4+2] = value & 255; bytes[i*4+3] = 255;
      }
      const started = performance.now();
      return await new Promise((resolve, reject) => {
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
        worker.onmessage = e => {
          if (e.data.type === 'complete' || e.data.type === 'error') {
            const { familyLabels, ...message } = e.data;
            worker.terminate(); resolve({ side, pixels: side*side, uniqueInput: unique, elapsedMs: performance.now()-started,
              ...(familyLabels ? { familyLabelsBytes: familyLabels.byteLength } : {}), ...message });
          }
        };
        worker.postMessage({ type: 'start', jobId: 1, buffer: bytes.buffer, width: side, height: side,
          options: mode === 'families' ? { mode, alphaPolicy: 'exclude-zero' } : { mode, match: 'rgba', alphaPolicy: 'exclude-zero' } }, [bytes.buffer]);
      });
    }
    return [await measure(2000, false), await measure(4000, false), await measure(1100, true), await measure(2000, false, 'families')];
  }, new URL(`assets/${workerAsset}`, baseURL).href);
  assert.equal(measurements[0].summary.includedPixels, 4_000_000); assert.equal(measurements[0].summary.rowCount, 4);
  assert.equal(measurements[1].summary.includedPixels, 16_000_000); assert.equal(measurements[2].type, 'error'); assert.match(measurements[2].message, /100万色/);
  assert.equal(measurements[3].summary.options.mode,'families'); assert.equal(measurements[3].familyLabelsBytes,4_000_000);
  results.push('4M/16M pixel Worker measurement, 1M color guard');

  // Cover the complete decode -> Canvas -> Worker pipeline, not only raw buffers.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await upload(png(2000,2000,(x,y)=>[x % 2 ? 255 : 0, y % 2 ? 255 : 0,0,255])); await analyze();
  const pipelineTiming = await page.locator('#timing').innerText();
  assert.equal(await page.locator('#total').innerText(), '4,000,000'); assert.equal(await page.locator('#color-count').innerText(), '4');
  await page.locator('#pixel-tools > summary').click();
  await page.locator('#zoom').selectOption('fit');
  assert.equal(await page.locator('#total').innerText(), '4,000,000');
  results.push('4M synthetic PNG full pipeline, preview does not change counts');

  await upload(png(4000,4000,()=>[16,32,64,255]));
  // Editor responsiveness at the 16-megapixel limit (desktop Chromium; phones are slower).
  let started = Date.now(); await page.locator('#open-editor').click(); await page.locator('#editor').waitFor();
  const editorOpenMs = Date.now() - started;
  const big = await page.locator('#editor-canvas').boundingBox();
  await page.mouse.move(big.x + 20, big.y + 20); await page.mouse.down();
  const frameMs = await page.evaluate(() => { const times = []; let last = performance.now(), stop = false;
    const tick = now => { times.push(now - last); last = now; if (!stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    window.__stopFrames = () => { stop = true; return times; }; return 0; });
  started = Date.now(); await page.mouse.move(big.x + big.width - 20, big.y + big.height - 20, { steps: 40 }); await page.mouse.up();
  const strokeMs = Date.now() - started; const frames = (await page.evaluate(() => window.__stopFrames())).slice(1).sort((a, b) => a - b);
  started = Date.now(); await page.locator('#editor-undo').click(); const undoMs = Date.now() - started;
  // Similar color at the worst case: every pixel matches, across the image and as one connected area.
  await page.locator('[data-shape="similar"]').click(); const center = [big.x + big.width / 2, big.y + big.height / 2];
  started = Date.now(); await page.mouse.click(...center); await page.evaluate(() => new Promise(requestAnimationFrame)); const similarAllMs = Date.now() - started;
  await page.locator('#editor-undo').click(); await page.locator('#editor-connected').check();
  started = Date.now(); await page.mouse.click(...center); await page.evaluate(() => new Promise(requestAnimationFrame)); const similarConnectedMs = Date.now() - started;
  await page.locator('#editor-connected').uncheck(); await page.locator('#editor-undo').click(); await page.locator('[data-shape="circle"]').click();
  started = Date.now(); await page.locator('#editor-save').click(); await page.locator('#editor-export').waitFor({ state: 'visible', timeout: 60000 }); const savePngMs = Date.now() - started;
  const editorPerformance = { pixels: 16_000_000, openMs: editorOpenMs, strokeMs, frameMedianMs: Math.round(frames[frames.length >> 1] ?? frameMs), frameMaxMs: Math.round(frames.at(-1) ?? 0), undoMs, similarAllMs, similarConnectedMs, savePngMs };
  assert(editorOpenMs < 10000 && undoMs < 5000, JSON.stringify(editorPerformance));
  await page.locator('#editor-close').click();
  results.push('16M pixel editor open/stroke/undo/save measured');
  await openPanel(page, 'analysis-options'); await page.locator('#analyze').click(); await page.locator('#cancel').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('キャンセル'));
  assert.equal(await page.locator('#workspace').isVisible(), true); assert.equal(await page.locator('#results').isVisible(), false);
  await analyze(); assert.equal(await page.locator('#included').innerText(), '16,000,000');
  await openPanel(page, 'analysis-options'); await page.locator('#analyze').click(); await page.locator('#clear').click();
  await page.locator('#sample').click(); await page.waitForFunction(()=>!document.querySelector('#analyze').disabled); await analyze();
  assert.equal(await page.locator('#total').innerText(), '960,000');
  results.push('cancel preserves image, retry succeeds, clear and replace discard stale results');

  await upload(png(500,500,(x,y)=>{ const n = y*500+x; return [n >>> 16,n >>> 8 & 255,n & 255,255]; })); await analyze();
  assert.equal(await page.locator('#color-count').innerText(), '250,000');
  await page.locator('#csv').click(); await page.locator('#cancel').click();
  assert.equal(await page.locator('#results').isVisible(), true);
  const dense = JSON.parse(await download('json')); assert.equal(dense.rows.length, 250000);
  results.push('250K colors: export cancellation preserves result, immediate new export succeeds');

  // Use actual touch events in an emulated mobile context, not a desktop click at a narrow width.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  touchContext.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(baseURL); await touchPage.locator('#sample').tap();
  await touchPage.waitForFunction(()=>!document.querySelector('#analyze').disabled); await touchPage.locator('#analyze').tap();
  await touchPage.waitForFunction(()=>document.querySelector('#notice').textContent.includes('解析が完了'));
  await touchPage.locator('[data-family="6"]').tap();
  await touchPage.waitForFunction(()=>document.querySelector('#mask-status').textContent.includes('青系の場所を表示中'));
  await touchPage.locator('#reset-family').tap();
  await touchPage.locator('#preview').tap(); assert.notEqual(await touchPage.locator('#pixel-hex').innerText(), '');
  await touchPage.locator('#json').tap(); await touchPage.locator('#download').waitFor({state:'visible'});
  const touchDownload = touchPage.waitForEvent('download'); await touchPage.locator('#download').tap(); assert.equal((await touchDownload).suggestedFilename(), 'color-analysis.json');
  await touchPage.setViewportSize({ width: 844, height: 390 }); assert.equal(await touchPage.locator('#total').innerText(), '960,000');
  await touchPage.setViewportSize({ width: 390, height: 844 });
  await touchPage.locator('#open-editor').tap();
  const mobileEditor = await touchPage.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    toolsBottom: document.querySelector('.editor-tools').getBoundingClientRect().bottom, height: innerHeight,
    stage: document.querySelector('#editor-stage').getBoundingClientRect().height }));
  assert(!mobileEditor.overflow && mobileEditor.toolsBottom <= mobileEditor.height + 1 && mobileEditor.stage > 300, JSON.stringify(mobileEditor));
  assert.equal(await touchPage.locator('#editor-look').getAttribute('open'), null, 'look settings start folded on phones');
  await plainLook(touchPage);
  const mobileBox = await touchPage.locator('#editor-canvas').boundingBox();
  await touchPage.touchscreen.tap(mobileBox.x + mobileBox.width * .3, mobileBox.y + mobileBox.height * .4);
  await touchPage.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await touchPage.evaluate(() => Array.from(document.querySelector('#editor-canvas').getContext('2d').getImageData(360, 320, 1, 1).data)), [212,135,114,255], 'touch tap restores color');
  assert.equal(await touchPage.locator('#editor-undo').isDisabled(), false);
  await touchPage.screenshot({ path: fileURLToPath(new URL('editor-mobile.png', output)) });
  await touchPage.locator('#editor-close').tap();
  await touchPage.close(); await touchContext.close(); results.push('Chromium mobile emulation: touch select/inspect/analyze/download, rotation, editor layout and touch restore');

  await page.locator('#clear').click();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#download').getAttribute('href'), null);
  assert.equal(await page.locator('#image-name').textContent(), '');
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length, cookies: document.cookie }));
  assert.deepEqual(storage, { local: 0, session: 0, databases: 0, caches: 0, workers: 0, cookies: '' });
  assert(requests.every(r => r.url.startsWith(baseURL) && r.method === 'GET' && !r.body && !new URL(r.url).search &&
    (new URL(r.url).pathname === new URL(baseURL).pathname || manifest.includes(new URL(r.url).pathname.slice(new URL(baseURL).pathname.length)))), 'unexpected network request');
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { browser: await browser.version(), viewportNote: 'Chromium desktop and resized viewports; not physical mobile devices', passed: results,
    layouts, pipelineTiming, editorPerformance, projectSubpath: new URL(baseURL).pathname, measurements: measurements.map(({ top, ...m }) => m), storage, requestPaths: [...new Set(requests.map(r=>new URL(r.url).pathname))], errors };
  await writeFile(new URL('browser-report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
