import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadChromium} from './playwright.mjs';
const browser=await(await loadChromium()).launch();
try {
 for(const width of [390,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(new URL('../public/index.html',import.meta.url).href);
  await page.evaluate(()=>{
   state.user={id:1,name:'Jacob'};state.view='parlays';
   const members=[{id:1,name:'Jacob'},{id:2,name:'Mason'},{id:3,name:'Chris'}];
   const legs=[{player:'Emmett Johnson',market:'rush_yds',side:'atleast',line:15,member_id:1,result:'W',actual:15},{player:'Rashee Rice',market:'receptions',side:'atleast',line:6,member_id:2,result:null},{player:'Kenneth Walker III',market:'anytime_td',side:'yes',line:null,member_id:3,result:'L',actual:0}];
   parlayState.season=2026;parlayState.week=1;
   parlayState.data={season:2026,week:1,me:{id:1,admin:false},members,slips:[{id:'11111111-1111-4111-8111-111111111111',season:2026,week:1,night:'Monday',title:'Monday night parlay',game_key:'Denver Broncos@Kansas City Chiefs',odds:10087,legs,version:1,created_by:1,has_image:true}],games:{'Denver Broncos@Kansas City Chiefs':{state:'in',detail:'Q3 · 8:12',away_score:14,home_score:17,progress:{'11111111-1111-4111-8111-111111111111':legs.map(l=>({...l,actual:l.player==='Rashee Rice'?4:l.actual}))}}},schedule:[{key:'Denver Broncos@Kansas City Chiefs'}]};
   window.fetch=async(url,options)=>{if(options?.method==='POST'){window.parlayWrites.push(JSON.parse(options.body));return Response.json({ok:true});}return Response.json(parlayState.data);};window.parlayWrites=[];
   paintParlays();
  });
  assert.match(await page.locator('.parlay-slip').innerText(),/Emmett Johnson · 15\+ Rushing yards/);
  assert.equal(await page.locator('.parlay-leg .hit').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(tmpdir(),`parlays-${width}.png`),fullPage:true});
  await page.locator('[data-parlay-edit]').click();
  await page.locator('[data-leg-index="0"] [data-field="member_id"]').selectOption('2');
  await page.locator('#parlay-form button[type=submit]').click();
  await page.waitForSelector('#parlay-new');
  assert.equal(await page.evaluate(()=>parlayWrites[0].legs[0].member_id),2);
  await page.locator('#parlay-new').click();
  // Deterministic OCR transport stub; recognition itself is checked separately.
  await page.evaluate(()=>window.Tesseract={createWorker:async()=>({recognize:async()=>({data:{text:'Emmett Johnson 15+ Yards\nEMMETT JOHNSON - ALT RUSHING YDS\nRashee Rice 6+ Receptions\nRASHEE RICE - ALT RECEPTIONS'}}),terminate:async()=>{}})});
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=300;c.getContext('2d').fillRect(0,0,300,300);return c.toDataURL().split(',')[1];});
  await page.locator('#parlay-image').setInputFiles({name:'slip.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>document.querySelectorAll('[data-leg-index]').length===2);
  assert.equal(await page.locator('[data-leg-index="0"] [data-field="side"]').inputValue(),'atleast');
  assert.equal(await page.locator('[data-leg-index="0"] [data-field="line"]').inputValue(),'15');
  assert.equal(await page.locator('[data-leg-index="1"] [data-field="line"]').inputValue(),'6');
  await page.locator('[name="game_key"]').selectOption('Denver Broncos@Kansas City Chiefs');
  await page.locator('[data-leg-index="0"] [data-field="member_id"]').selectOption('1');
  await page.locator('[data-leg-index="1"] [data-field="member_id"]').selectOption('2');
  await page.screenshot({path:join(tmpdir(),`parlays-upload-${width}.png`),fullPage:true});
  await page.locator('#parlay-form button[type=submit]').click();
  await page.waitForSelector('#parlay-new');
  const posted=await page.evaluate(()=>parlayWrites.at(-1));
  assert.equal(posted.legs.length,2);assert.equal(posted.legs[0].side,'atleast');assert.match(posted.image,/^data:image\/jpeg;base64,/);
  await page.locator('#parlay-new').click();
  await page.evaluate(()=>{
   parlayState.draft.game_key='Denver Broncos@Kansas City Chiefs';
   parlayState.draft.legs=parseParlayText('Kenneth Walker III Over 3.5\nPatrick Mahomes Rushing Yards\nOver13.5');
   paintParlays();
  });
  assert.equal(await page.locator('[data-leg-index="0"] [data-field="market"]').inputValue(),'');
  const before=await page.evaluate(()=>parlayWrites.length);
  await page.locator('#parlay-form button[type=submit]').click();
  assert.equal(await page.evaluate(()=>parlayWrites.length),before,'unresolved OCR must not save');
  await page.locator('[data-leg-index="0"] [data-field="market"]').selectOption('receptions');
  await page.locator('[data-field="reviewed"]').check();
  await page.locator('#parlay-form button[type=submit]').click();
  await page.waitForSelector('#parlay-new');
  assert.equal(await page.evaluate(()=>parlayWrites.length),before+1);
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px: live cards, leaderboard, edit assignments, upload review and save`);await page.close();
 }
}finally{await browser.close();}
