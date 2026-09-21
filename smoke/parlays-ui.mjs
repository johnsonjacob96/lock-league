import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadChromium} from './playwright.mjs';
const browser=await(await loadChromium()).launch();
try {
 for(const width of [375,390,1440]) {
  const page=await browser.newPage({viewport:{width,height:width===375?667:width===390?844:1000}}),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.goto(new URL('../public/index.html',import.meta.url).href,{waitUntil:'domcontentloaded'});
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
  assert.equal(await page.locator('.parlay-shame').count(),0,'no blame while another leg is open');
  await page.evaluate(()=>{
   window.hallOriginal=structuredClone(parlayState.data);
   const s=parlayState.data.slips[0];s.odds=14819;s.legs[1].result='W';
   s.legs.splice(2,0,...['Patrick Mahomes','RJ Harvey','Courtland Sutton','Kenneth Walker III'].map(player=>({...s.legs[0],player})));
   parlayState.data.slips.push({...structuredClone(s),id:'22222222-2222-4222-8222-222222222222',week:2,odds:1000});paintParlays();
  });
  assert.match(await page.locator('.parlay-shame-card').first().innerText(),/Chris/);
  assert.equal(await page.locator('.parlay-shame-amount').first().innerText(),'$740.95');
  assert.match(await page.locator('.parlay-shame-card').first().innerText(),/PARLAY KILLER/);
  assert.match(await page.locator('.parlay-shame-card').first().innerText(),/THE DAMAGE/);
  assert.equal(await page.locator('.parlay-shame-card').first().locator('.hit').count(),6);
  assert.equal(await page.locator('.parlay-shame-card').first().locator('.miss').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(width<700){const box=await page.locator('.parlay-shame-card').first().boundingBox();assert.ok(box.height<=page.viewportSize().height-160,`card ${box.height}px must fit between mobile header and nav`);}
  await page.screenshot({path:join(tmpdir(),`parlay-shame-${width}.png`),fullPage:true});
  await page.locator('.parlay-shame-card').first().evaluate(el=>el.scrollIntoView({block:'center'}));
  if(width<700){const card=await page.locator('.parlay-shame-card').first().boundingBox(),nav=await page.locator('#mobile-nav').boundingBox();assert.ok(card.y>=0&&card.y+card.height<=nav.y,'whole card visible above bottom navigation');}
  await page.locator('.parlay-shame-card').first().screenshot({path:join(tmpdir(),`parlay-shame-card-${width}.png`)});
  await page.locator('.parlay-shame-more summary').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>parlayState.hallExpanded);
  await page.evaluate(()=>paintParlays());assert.equal(await page.locator('.parlay-shame-more').getAttribute('open'),'');
  await page.locator('#parlay-night').selectOption('Thursday');assert.equal(await page.locator('.parlay-shame').count(),0);
  await page.locator('#parlay-night').selectOption('All');assert.equal(await page.locator('.parlay-shame').count(),1);
  await page.evaluate(()=>{parlayState.data.slips.forEach(s=>s.legs.forEach(l=>{l.result='W';}));paintParlays();});
  assert.equal(await page.locator('.parlay-shame').count(),0,'corrected results remove Hall entries');
  await page.evaluate(()=>{parlayState.data=window.hallOriginal;parlayState.hallExpanded=false;paintParlays();});
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
  await page.locator('#parlay-new').click();
  await page.locator('#parlay-add').click();
  await page.locator('[data-field="market"]').selectOption('game_total');
  assert.equal(await page.locator('[data-field="player"]').isDisabled(),true);
  assert.deepEqual(await page.locator('[data-field="side"] option').allTextContents(),['Choose direction','Over','Under']);
  await page.locator('[data-field="side"]').selectOption('under');
  await page.locator('[data-field="line"]').fill('54.5');
  await page.locator('[name="game_key"]').selectOption('Denver Broncos@Kansas City Chiefs');
  await page.screenshot({path:join(tmpdir(),`parlays-game-total-${width}.png`),fullPage:true});
  await page.locator('#parlay-form button[type=submit]').click();
  await page.waitForSelector('#parlay-new');
  const total=await page.evaluate(()=>parlayWrites.at(-1).legs[0]);
  assert.equal(total.market,'game_total');assert.equal(total.side,'under');assert.equal(total.line,54.5);
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px: live cards, leaderboard, edit assignments, upload review and save`);await page.close();
 }
}finally{await browser.close();}
