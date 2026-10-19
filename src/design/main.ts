import './styles.css';
import { landscape } from './sample.ts';
import { decode, validateFile } from '../image/read.ts';
import { FAMILIES } from '../analysis/families.ts';
import type { Row, Response, Summary } from '../types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('image');
let original: ImageData | undefined, labels: Uint8Array | undefined, rows: Row[] = [], summary: Summary | undefined;
let generation = 0, maskGeneration = 0, worker: Worker | undefined, selected: number | undefined, downloadUrl: string | undefined;
const number = (n: number) => n.toLocaleString('ja-JP');
const ratio = (n: number) => n > 0 && n < .0001 ? '<0.01' : (n * 100).toFixed(2);
const text = (id: string, value: string) => { $(id).textContent = value; };

function setDesign(design: 'gallery' | 'editorial') {
  document.body.dataset.design = design;
  for (const id of ['gallery','editorial']) $(id).setAttribute('aria-pressed', String(id === design));
  text('overline', design === 'gallery' ? 'A / GALLERY' : 'B / EDITORIAL');
  if (design === 'gallery') text('headline','写真と、色の構成。');
  else {
    const first=document.createElement('span'), second=document.createElement('span');
    first.textContent='一枚のなかの、'; second.textContent='色の関係。'; $('headline').replaceChildren(first,second);
  }
  text('study-title', design === 'gallery' ? 'A案：画像を主役にした、静かな道具。' : 'B案：解析結果を、一枚の誌面として。');
  text('study-description', design === 'gallery' ? '視線は「画像 → 色帯 → 数値」へ。操作を少なく見せながら、色を押すと画像と結果がつながります。日常的に使うツールとして、こちらを推奨します。' : '大きなタイポグラフィ、細い罫線、余白のリズム。写真と数値を同じ重さで扱い、結果をじっくり眺めたくなる構成です。印象的な分析レポートに向いています。');
}

function fitImage() {
  if (!original) return;
  const stage=$('image-stage'), style=getComputedStyle(stage);
  const width=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const height=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  const scale=Math.min(width/original.width,height/original.height);
  canvas.style.width=`${Math.max(1,original.width*scale)}px`; canvas.style.height=`${Math.max(1,original.height*scale)}px`;
}

function colorSwatch(row: Row): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 20 20'); svg.setAttribute('aria-hidden','true');
  const rect = document.createElementNS(svg.namespaceURI,'rect'); rect.setAttribute('width','20'); rect.setAttribute('height','20');
  rect.setAttribute('fill',`rgb(${row.rgb.join(',')})`); svg.append(rect); return svg;
}

function render() {
  if (!summary || !rows.length) {
    text('dominant-family','対象なし'); text('dominant-ratio','0.00'); text('family-count','0 系統');
    $('families').replaceChildren(); $('palette').replaceChildren(); $('palette-legend').replaceChildren(); return;
  }
  const dominant = rows[0];
  text('dominant-family', dominant.family!); text('dominant-ratio', ratio(dominant.ratio));
  text('family-count',`${rows.length} 系統`); text('pixel-total',`${number(summary.includedPixels)} pixels`);
  const container = $('families'); container.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button'); button.type='button'; button.className='family-row'; button.dataset.family=String(row.key);
    button.setAttribute('aria-pressed',String(selected === row.key));
    button.append(colorSwatch(row));
    const name = document.createElement('span'); name.className='family-name'; name.textContent=row.family!;
    const bar = document.createElementNS('http://www.w3.org/2000/svg','svg'); bar.setAttribute('viewBox','0 0 100 4'); bar.setAttribute('preserveAspectRatio','none'); bar.classList.add('row-bar'); bar.setAttribute('aria-hidden','true');
    const rect = document.createElementNS(bar.namespaceURI,'rect'); rect.setAttribute('width',String(row.ratio * 100)); rect.setAttribute('height','4'); rect.setAttribute('fill',`rgb(${row.rgb.join(',')})`); bar.append(rect);
    const value = document.createElement('span'); value.className='family-ratio'; value.textContent=`${ratio(row.ratio)}%`;
    button.append(name,bar,value); button.addEventListener('click',()=>{ void highlight(selected === row.key ? undefined : row.key); }); container.append(button);
  }
  const palette = $('palette'); palette.replaceChildren();
  const strip = document.createElementNS('http://www.w3.org/2000/svg','svg'); strip.setAttribute('viewBox','0 0 1000 48'); strip.setAttribute('preserveAspectRatio','none'); strip.setAttribute('aria-hidden','true');
  let x=0;
  for (const row of rows) {
    const rect=document.createElementNS(strip.namespaceURI,'rect'); rect.setAttribute('x',String(x*1000)); rect.setAttribute('width',String(row.ratio*1000)); rect.setAttribute('height','48'); rect.setAttribute('fill',`rgb(${row.rgb.join(',')})`); strip.append(rect); x+=row.ratio;
  }
  palette.append(strip);
  const legend=$('palette-legend'); legend.replaceChildren();
  for (const row of rows) {
    const button=document.createElement('button'); button.type='button'; button.dataset.family=String(row.key); button.className='legend-button';
    button.setAttribute('aria-pressed',String(selected === row.key)); button.append(colorSwatch(row));
    const label=document.createElement('span'); label.textContent=`${row.family} ${ratio(row.ratio)}%`; button.append(label);
    button.addEventListener('click',()=>{ void highlight(selected === row.key ? undefined : row.key); }); legend.append(button);
  }
}

async function highlight(key?: number) {
  if (!original || !labels) return;
  const revision=++maskGeneration, pixels=original, mapping=labels;
  selected=key;
  for (const button of document.querySelectorAll<HTMLElement>('[data-family]')) button.setAttribute('aria-pressed',String(Number(button.dataset.family) === key));
  $('restore').hidden=key === undefined;
  text('image-tag',key === undefined ? 'ORIGINAL' : `${FAMILIES[key].label}の場所`);
  if (key === undefined) { canvas.getContext('2d')!.putImageData(pixels,0,0); text('status','元画像を表示しています。色の割合と数値は変わりません。'); return; }
  text('status',`${FAMILIES[key].label}の場所を準備しています…`);
  try {
    const output=new Uint8ClampedArray(pixels.data.length);
    for (let start=0; start<mapping.length; start+=131072) {
      if (revision !== maskGeneration) return;
      for (let p=start;p<Math.min(start+131072,mapping.length);p++) {
        const i=p*4;
        if (mapping[p] === key) { for (let c=0;c<4;c++) output[i+c]=pixels.data[i+c]; }
        else { output[i]=output[i+1]=output[i+2]=33; output[i+3]=pixels.data[i+3] ? 225 : 0; }
      }
      await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    if (revision !== maskGeneration) return;
    canvas.getContext('2d')!.putImageData(new ImageData(output,pixels.width,pixels.height),0,0);
    const row=rows.find(row=>row.key===key)!;
    text('status',`${row.family} ${ratio(row.ratio)}% の場所を表示中。もう一度選ぶと元画像に戻ります。`);
  } catch {
    if (revision === maskGeneration) { await highlight(); text('status','強調表示を準備できなかったため、元画像を表示しています。'); }
  }
}

function release() {
  generation++; maskGeneration++; worker?.terminate(); worker=undefined; original=undefined; labels=undefined; rows=[]; summary=undefined; selected=undefined;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl=undefined;
  canvas.width=canvas.height=0; $('families').replaceChildren(); $('palette').replaceChildren(); $('palette-legend').replaceChildren();
  text('image-name','画像を選択してください'); text('dimensions','—'); text('image-description','画像は端末内で処理します');
  $('restore').hidden=true; $<HTMLButtonElement>('save').disabled=true;
  text('image-tag','ORIGINAL'); text('dominant-family','—'); text('dominant-ratio','—'); text('family-count','— 系統'); text('pixel-total','— pixels');
}

function analyze(pixels: ImageData, title: string, description: string) {
  original=pixels; canvas.width=pixels.width; canvas.height=pixels.height; canvas.getContext('2d')!.putImageData(pixels,0,0);
  text('image-name',title); text('dimensions',`${number(pixels.width)} × ${number(pixels.height)} px`); text('image-description',description);
  fitImage();
  text('status','画像を縮小せず、全ピクセルを解析しています…');
  const id=generation;
  worker=new Worker(new URL('../workers/analysis.worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=(event:MessageEvent<Response>)=>{
    const message=event.data; if (id !== generation || message.jobId !== id) return;
    if (message.type==='complete') {
      summary=message.summary; rows=message.top; labels=message.familyLabels ? new Uint8Array(message.familyLabels) : undefined;
      render(); $<HTMLButtonElement>('save').disabled=false;
      text('status',`${number(summary.includedPixels)}ピクセルを解析しました。色系統を押して、画像内の場所を確かめられます。`);
    } else if (message.type==='error') text('status',message.message);
  };
  worker.onerror=()=>{ if (id === generation) text('status','解析を実行できませんでした。別のブラウザか小さな画像でお試しください。'); };
  const buffer=pixels.data.slice().buffer;
  worker.postMessage({type:'start',jobId:id,width:pixels.width,height:pixels.height,buffer,options:{mode:'families',alphaPolicy:'exclude-zero'}},[buffer]);
}

async function loadFile(file:File) {
  release(); const id=generation; text('status','画像を確認しています…');
  try {
    const header=await validateFile(file); if (id !== generation) return;
    const decoded=await decode(file,header); decoded.bitmap.close(); if (id !== generation) return;
    analyze(decoded.pixels,file.name,'端末内の画像 / 外部送信なし');
  } catch (error) { if (id === generation) text('status',error instanceof Error ? error.message : '画像を読み込めませんでした。'); }
}

$('gallery').addEventListener('click',()=>setDesign('gallery'));
$('editorial').addEventListener('click',()=>setDesign('editorial'));
$('restore').addEventListener('click',()=>{ void highlight(); });
$<HTMLInputElement>('file').addEventListener('change',()=>{ const f=$<HTMLInputElement>('file').files?.[0]; if (f) void loadFile(f); $<HTMLInputElement>('file').value=''; });
$('sample').addEventListener('click',()=>{ release(); analyze(landscape(),'静かな水辺','コードで描いた風景サンプル / 実写写真ではありません'); });
$('save').addEventListener('click',()=>{
  if (!summary) return;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  const {rowCount:_rowCount,...metadata}=summary;
  downloadUrl=URL.createObjectURL(new Blob([JSON.stringify({...metadata,rows})],{type:'application/json'}));
  const link=document.createElement('a'); link.href=downloadUrl; link.download='color-analysis.json'; link.click();
});
window.addEventListener('pagehide',release);
new ResizeObserver(fitImage).observe($('image-stage'));
window.addEventListener('pageshow',event=>{ if (event.persisted) { release(); analyze(landscape(),'静かな水辺','コードで描いた風景サンプル / 実写写真ではありません'); } });
setDesign('gallery'); analyze(landscape(),'静かな水辺','コードで描いた風景サンプル / 実写写真ではありません');
