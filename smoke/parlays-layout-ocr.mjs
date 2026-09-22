// Real user-provided complete screenshots. Expected values never enter OCR.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {loadChromium} from './playwright.mjs';
import {ocrBrowserTransport} from './ocr-browser.mjs';
const fixtures=JSON.parse(readFileSync(new URL('./assets/parlay-images/expected.json',import.meta.url)));
const browser=await(await loadChromium()).launch(),captures=[];
try {
 const page=await browser.newPage();await ocrBrowserTransport(page.context());
 await page.goto(new URL('../public/index.html',import.meta.url).href,{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{const parse=parseParlayLayout;window.parseParlayLayout=(passes,width,height)=>{window.lastOcr={passes,width,height};return parse(passes,width,height);};});
 for(const fixture of fixtures) {
  const base64=readFileSync(new URL('./assets/parlay-images/'+fixture.image,import.meta.url)).toString('base64'),start=Date.now();
  const {doc,capture}=await page.evaluate(async ({base64,name})=>{
   const draft={},file=new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],name);
   const doc=await readParlayImage(file,draft);if(!draft.image)throw Error('Screenshot preview missing');
   return {doc,capture:window.lastOcr};
  },{base64,name:fixture.image});
  assert.deepEqual(doc.legs.map(l=>[l.player,l.market,l.side,l.line]),fixture.legs,fixture.image);
  assert.equal(doc.odds,fixture.odds);assert.equal(doc.declared_count,fixture.declared_count);
  assert.deepEqual(doc.warnings,[]);assert.equal(doc.count_review,false);
  for(const l of doc.legs){assert.ok(l.source_text);const b=l.source_box;assert.ok(b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1&&b.y+b.height<=1);}
  captures.push({image:fixture.image,...capture});
  console.log(`PASS ${fixture.image}: ${doc.legs.length} exact selections, +${doc.odds}, evidence for every leg (${Date.now()-start}ms)`);
 }
 if(process.env.CAPTURE_PARLAY_OCR)writeFileSync(process.env.CAPTURE_PARLAY_OCR,JSON.stringify(captures));
}finally{await browser.close();}
