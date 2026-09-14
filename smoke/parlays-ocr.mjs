// Optional network test: node smoke/parlays-ocr.mjs. Uses the real browser OCR
// engine on deterministic images; no account, vendor API key or saved slips.
import assert from 'node:assert/strict';
import {loadChromium} from './playwright.mjs';
const browser=await(await loadChromium()).launch();
try {
 const page=await browser.newPage();await page.goto(new URL('../public/index.html',import.meta.url).href);
 for(const tall of [false,true]) {
  const result=await page.evaluate(async tall=>{
   const canvas=document.createElement('canvas');canvas.width=tall?390:1083;canvas.height=tall?3100:1369;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#1e1e1e';ctx.fillRect(0,0,canvas.width,canvas.height);
   const lines=[['Kenneth Walker III Over +3.5','KENNETH WALKER III - TOTAL RECEPTIONS'],['Patrick Mahomes Over +13.5','PATRICK MAHOMES - RUSHING YDS'],['RJ Harvey Over +16.5','RJ HARVEY - RECEIVING YDS'],['Emmett Johnson 15+ Yards','EMMETT JOHNSON - ALT RUSHING YDS'],['Rashee Rice 6+ Receptions','RASHEE RICE - ALT RECEPTIONS'],['Courtland Sutton Over +3.5','COURTLAND SUTTON - TOTAL RECEPTIONS'],['Kenneth Walker III','ANY TIME TOUCHDOWN SCORER']];
   for(const [i,line] of lines.entries()){
    ctx.fillStyle='#0765c4';ctx.font=`bold ${tall?18:46}px Arial`;ctx.fillText(line[0],tall?12:100,(tall?160:150)+i*(tall?430:165));
    ctx.fillStyle='#a5a9ae';ctx.font=`${tall?12:32}px Arial`;ctx.fillText(line[1],tall?12:100,195+i*(tall?430:165));
   }
   const blob=await new Promise(resolve=>canvas.toBlob(resolve));
   const parsed=await readParlayImage(new File([blob],'slip.png',{type:'image/png'}),{});
   return parsed.legs.map(l=>({player:l.player,market:l.market,side:l.side,line:l.line,crop:!!l.source_crop,review:l.review}));
  },tall);
  assert.equal(result.length,7);
  assert.deepEqual(result.map(l=>l.market),['receptions','rush_yds','rec_yds','rush_yds','receptions','receptions','anytime_td']);
  assert.deepEqual(result.map(l=>l.line),[3.5,13.5,16.5,15,6,3.5,null]);
  assert.equal(result[3].side,'atleast');assert.equal(result[4].side,'atleast');
  assert.ok(result.every(l=>l.crop&&!l.review.length));
  console.log(`PASS real OCR: ${tall?'tall 390×3100':'standard 1083×1369'}, seven correct legs and source crops`);
 }
}finally{await browser.close();}
