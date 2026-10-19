import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { png } from '../fixtures/png.ts';

const dist=new URL('../../dist/',import.meta.url), output=new URL('../../.local/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('asset-manifest.json',dist),'utf8'));
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.replace(/^\/color-analysis\//,'');
  if (req.method!=='GET' || !manifest.includes(name)) { res.writeHead(404).end(); return; }
  try {
    const type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/plain';
    res.writeHead(200,{'Content-Type':type+';charset=utf-8'}).end(await readFile(new URL(name,dist)));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/color-analysis/`;
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_BROWSER_EXECUTABLE || undefined}).catch(error=>{server.close();throw error;});
const errors=[],requests=[],checks=[];
const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
context.on('request',r=>requests.push({url:r.url(),method:r.method(),body:r.postData()}));
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const imageBytes=()=>page.evaluate(()=>document.querySelector('#image').toDataURL());
async function savedJson() {
  const pending=page.waitForEvent('download'); await page.locator('#save').click();
  const download=await pending, parts=[]; for await(const p of await download.createReadStream())parts.push(p);
  return JSON.parse(Buffer.concat(parts).toString());
}
try {
  await page.goto(new URL('design.html',base).href);
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  const first=await savedJson(); assert.equal(first.totalPixels,1080000); assert.equal(first.options.mode,'families');
  const initialImage=await imageBytes(); const familyText=await page.locator('#families').innerText();
  await page.locator('#editorial').click();
  assert.equal(await page.locator('body').getAttribute('data-design'),'editorial');
  assert.equal(await imageBytes(),initialImage); assert.deepEqual(await savedJson(),first);
  assert.equal(await page.locator('#families').innerText(),familyText);
  checks.push('A/B preserve image pixels, all statistics and JSON export');

  const blue=page.locator('.family-list [data-family="6"]'); await blue.click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('の場所を表示中'));
  const highlighted=await imageBytes(); assert.notEqual(highlighted,initialImage);
  await page.locator('#gallery').click(); assert.equal(await imageBytes(),highlighted);
  assert.equal(await blue.getAttribute('aria-pressed'),'true');
  await page.locator('#restore').click(); assert.equal(await imageBytes(),initialImage);
  checks.push('family selection, A/B preserve selection, restore original');

  const layouts=[];
  for(const design of ['gallery','editorial']) for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:width===1440?1050:844}); await page.locator(`#${design}`).click();
    await page.evaluate(()=>scrollTo(0,0));
    const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      image:document.querySelector('#image-stage').getBoundingClientRect().toJSON(),reading:document.querySelector('.reading-column').getBoundingClientRect().toJSON()}));
    assert(metrics.scrollWidth<=width,`overflow: ${design} ${width} ${metrics.scrollWidth}`);
    assert(await page.evaluate(()=>{
      const image=document.querySelector('#image'), box=image.getBoundingClientRect(), stage=document.querySelector('#image-stage').getBoundingClientRect();
      return box.top>=stage.top && box.bottom<=stage.bottom && box.left>=stage.left && box.right<=stage.right && Math.abs(box.width/box.height-image.width/image.height)<.01;
    }),`cropped or distorted image: ${design} ${width}`);
    if(width<760)assert(metrics.reading.top>metrics.image.top);
    layouts.push({design,width,scrollWidth:metrics.scrollWidth});
    if(width!==320)await page.screenshot({path:fileURLToPath(new URL(`design-${design}-${width===1440?'desktop':'mobile'}.png`,output)),fullPage:true});
  }
  checks.push('A/B at 1440/390/320px without page overflow; mobile stacking');

  await page.locator('#file').setInputFiles({name:'synthetic-private-name.png',mimeType:'image/png',buffer:png(10,1,x=>x<8?[70,140,190,255]:[255,0,0,255])});
  await page.waitForFunction(()=>!document.querySelector('#save').disabled && document.querySelector('#image').width===10);
  const custom=await savedJson(); assert.equal(custom.totalPixels,10); assert.equal(custom.rows.find(r=>r.key===6).ratio,.8);
  assert(!JSON.stringify(custom).includes('synthetic-private-name'));
  await page.locator('#gallery').click(); assert.deepEqual(await savedJson(),custom);
  await page.locator('#file').setInputFiles({name:'fake.png',mimeType:'image/png',buffer:Buffer.from('<svg/>')});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('対応形式'));
  assert.equal(await page.locator('#image').getAttribute('width'),'0');
  checks.push('local upload, no filename in export, mode switch preserves custom input, invalid input cleared');

  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
  mobile.on('request',r=>requests.push({url:r.url(),method:r.method(),body:r.postData()}));
  const touch=await mobile.newPage(); touch.on('pageerror',e=>errors.push(e.message));
  await touch.goto(new URL('design.html',base).href); await touch.waitForFunction(()=>!document.querySelector('#save').disabled);
  await touch.locator('#editorial').tap(); await touch.locator('.family-list [data-family="6"]').tap();
  await touch.waitForFunction(()=>document.querySelector('#status').textContent.includes('の場所を表示中'));
  await touch.locator('#gallery').tap(); await touch.locator('#restore').tap();
  const download=touch.waitForEvent('download'); await touch.locator('#save').tap(); assert.equal((await download).suggestedFilename(),'color-analysis.json');
  await mobile.close(); checks.push('Chromium touch emulation: A/B, selection, restore, JSON download');

  assert.deepEqual(await context.cookies(),[]);
  const storage=await page.evaluate(async()=>({local:localStorage.length,session:sessionStorage.length,databases:(await indexedDB.databases()).length,caches:(await caches.keys()).length,workers:(await navigator.serviceWorker.getRegistrations()).length}));
  assert(Object.values(storage).every(v=>v===0));
  assert(requests.every(r=>r.url.startsWith(base)&&r.method==='GET'&&!r.body&&!new URL(r.url).search&&manifest.includes(new URL(r.url).pathname.slice('/color-analysis/'.length))));
  assert.deepEqual(errors,[]); checks.push('strict production CSP, only allowlisted local assets, no persistent user storage');
  const result={browser:await browser.version(),checks,layouts,storage,requests:[...new Set(requests.map(r=>new URL(r.url).pathname))],errors};
  await writeFile(new URL('design-report.json',output),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} finally {await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
