// Optional real OCR regression: saved slip crop plus a representative expanded
// header/footer. No production requests, accounts, or writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadChromium} from './playwright.mjs';
import {ocrBrowserTransport} from './ocr-browser.mjs';
const browser=await(await loadChromium()).launch();
try {
 const page=await browser.newPage();await ocrBrowserTransport(page.context());
 await page.goto(new URL('../public/index.html',import.meta.url).href,{waitUntil:'domcontentloaded'});
 const base64=readFileSync(new URL('./assets/parlay-expanded-legs.jpg',import.meta.url)).toString('base64');
 for(const expanded of [false,true]) {
  const doc=await page.evaluate(async ({base64,expanded})=>{
   const blob=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/jpeg'});
   let file=new File([blob],'legs.jpg',{type:'image/jpeg'});
   if(expanded){
    const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');
    canvas.width=1260;canvas.height=bitmap.height+780;
    const c=canvas.getContext('2d');c.fillStyle='#1e1e1e';c.fillRect(0,0,canvas.width,canvas.height);
    const line=(text,x,y,size=34,color='#a5a9ae')=>{c.fillStyle=color;c.font=`${size}px Arial`;c.fillText(text,x,y);};
    line('Open              Settled              Saved',50,65,40,'#2589e6');
    line('SGP Same Game Parlay',50,165,44,'#2589e6');
    line('+30504',870,165);c.fillStyle='#ffdd38';c.fillRect(1000,120,245,65);line('+38132',1010,165,44,'#111');
    line('REWARDS 30 PTS PENDING     PROFIT BOOST 25%',50,235);
    line('BET PROTECT+',50,290);
    line('D.J. Moore Over 63.5 D.J. Moore - Receiving Yds, Under 54.5 Total',50,365,30);
    line('Points, Sam LaPorta Any Time Touchdown Scorer, Josh Allen Over...',50,410,30);
    line('Detroit Lions @ Buffalo Bills',50,500);line('7:15PM CT',1020,500,28);
    c.drawImage(bitmap,0,550);bitmap.close();
    line('$5.00                       $1911.65',50,canvas.height-160);
    line('TOTAL CHARGED: $5.00         TOTAL PAYOUT',50,canvas.height-115,28);
    line('Cash out $1.74',50,canvas.height-55);
    file=new File([await new Promise(r=>canvas.toBlob(r))],'expanded.png',{type:'image/png'});
   }
   const doc=await readParlayImage(file,{});
   return {...doc,legs:doc.legs.map(({source_crop,...l})=>l)};
  },{base64,expanded});
  console.log(JSON.stringify({expanded,...doc},null,2));
  assert.equal(doc.legs.length,8);
  assert.deepEqual(doc.legs.map(l=>l.player),['D.J. Moore','Game total','Sam LaPorta','Josh Allen','D.J. Moore','Amon-Ra St. Brown','Josh Allen','Jahmyr Gibbs']);
  assert.deepEqual(doc.legs.map(l=>l.market),['rec_yds','game_total','anytime_td','rush_yds','receptions','receptions','anytime_td','rec_yds']);
  const expected=[63.5,54.5,null,31.5,4.5,7.5,null,30.5];
  for(const [i,leg] of doc.legs.entries()) {
   // Exact numbers are mandatory on the real saved crop. A recomposed/tiled
   // image may lower OCR confidence: it must request correction, never return
   // a wrong number or silently discard the leg.
   if(expanded&&expected[i]!=null&&leg.line==null) {
    assert.ok(leg.review.some(w=>w.includes('Low-confidence')));
    assert.ok(leg.source_text.includes(String(expected[i])));
   } else assert.equal(leg.line,expected[i]);
  }
  assert.equal(doc.legs[1].side,'under');
  if(expanded){assert.ok(doc.odds===38132||doc.odds===null);if(doc.odds===null)assert.ok(doc.warnings.some(w=>w.includes('combined odds')));}
  console.log(`PASS real OCR: ${expanded?'expanded':'cropped'} eight-leg slip`);
 }
}finally{await browser.close();}
