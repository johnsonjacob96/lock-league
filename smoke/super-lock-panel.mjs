import {readFileSync,mkdirSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PROP_DEFS} from '../functions/_shared/props.js';
const {chromium}=await import(pathToFileURL(execSync('npm root -g').toString().trim()+'/playwright/index.mjs').href);
const dir=fileURLToPath(new URL('../',import.meta.url));
const output=process.argv[2]||'/tmp/lock-league-super-lock';mkdirSync(output,{recursive:true});
const markets=Object.entries(PROP_DEFS).map(([market,def])=>({market,...def,players:[{player:'Jalen Hurts',line:39.5,fanduel:{line:39.5,over:-115,under:-110,yes:120},draftkings:{line:40.5,over:-105,under:-125,yes:130},alts:[{line:50.5,fanduel:140,draftkings:150}]}]}));
const server=createServer((req,res)=>{try{const path=req.url.split('?')[0];res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.json')?'application/json':'text/html');res.end(readFileSync(dir+'public'+(path==='/'?'/index.html':path)));}catch{res.statusCode=404;res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();let checks=0;
for(const width of [375,390,844,1440]) {
 const page=await browser.newPage({viewport:{width,height:920}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));let rejectSave=false;
 await page.clock.setFixedTime(new Date('2026-09-09T15:00Z'));
 await page.route('**/api/**',async route=>{
  if(route.request().url().includes('/api/props'))return route.fulfill({json:{markets}});
  if(route.request().method()==='POST'&&route.request().url().includes('/api/picks')){
   writes.push(route.request().postDataJSON());return route.fulfill({status:rejectSave?409:200,json:rejectSave?{error:'prop-not-offered'}:{}});
  }
  return route.fulfill({json:{}});
 });
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.evaluate(data=>{
  DATA=data;state.user={id:5,name:'Jacob'};state.serverConfig={season:2026,week:1,cutoff:'2026-09-13T17:00Z'};state.season='2026';state.view='thisweek';
  const books={fanduel:{spread:{fav:'Philadelphia Eagles',line:-3.5,favPrice:-110,dogPrice:-110},total:{point:47.5,overPrice:-110,underPrice:-110}},draftkings:{spread:{fav:'Philadelphia Eagles',line:-3,favPrice:-115,dogPrice:-105},total:{point:48.5,overPrice:-108,underPrice:-112}}};
  state.thisWeekData={games:[{away:'Dallas Cowboys',home:'Philadelphia Eagles',kickoff:'2026-09-13T17:00Z',books},{away:'Chicago Bears',home:'Carolina Panthers',kickoff:'2026-09-13T20:25Z',books},{away:'Buffalo Bills',home:'New York Jets',kickoff:'2026-09-08T17:00Z',books}],source:'sharpapi'};
  currentMyPicks={};state.myCardOpen=true;document.getElementById('root').innerHTML=renderThisWeek();refreshSuperLockEditor();
 },JSON.parse(readFileSync(dir+'public/data/seasons.json','utf8')));
 await page.locator('#sl-open').click();
 assert.equal(await page.locator('#sl-dialog').evaluate(d=>d.open),true);checks++;
 const ordering=await page.evaluate(()=>{
  const g=(id,total,kickoff='2026-09-13T17:00Z')=>({id,kickoff,books:{fanduel:{total:{point:total}}}});
  const higher=g('highest',49.5);higher.books.draftkings={total:{point:51.5}};
  return slSortGames([g('missing',null),g('low',42.5),g('started',60,'2026-09-08T17:00Z'),higher,g('tied-later',51.5,'2026-09-13T20:25Z')]).map(x=>x.id);
 });assert.deepEqual(ordering,['started','missing','low','highest','tied-later']);checks++;
 assert.equal(await page.locator('[data-slgame]:disabled').count(),1);checks++;
 const yardage=await page.evaluate(()=>{
  const m={market:'rush_yds',kind:'ou',players:[{player:'Low',line:20,fanduel:{line:20,over:-110}},{player:'High',line:70,fanduel:{line:70,over:-115},draftkings:{line:80,over:-105}},{player:'Missing'},{player:'Tie',line:80,fanduel:{line:80,over:-110}}]};
  // Every O/U market sorts highest-line-first; anytime TD (kind 'yes', no line) keeps board order.
  return {yards:slSortedPlayers(m).map(x=>[x.pl.player,x.pi]),other:slSortedPlayers({...m,market:'anytime_td',kind:'yes'}).map(x=>x.pl.player)};
 });assert.deepEqual(yardage.yards,[['High',1],['Tie',3],['Low',0],['Missing',2]]);assert.deepEqual(yardage.other,['Low','High','Missing','Tie']);checks+=2;
 // Non-yardage counting markets (receptions/attempts/TDs/…) now sort highest-first too.
 const counting=await page.evaluate(()=>{
  const m={market:'receptions',kind:'ou',players:[{player:'Two',line:2.5,fanduel:{line:2.5,over:-120}},{player:'Seven',line:7.5,fanduel:{line:7.5,over:-115}},{player:'Five',line:5.5,fanduel:{line:5.5,over:-110}}]};
  return slSortedPlayers(m).map(x=>x.pl.player);
 });assert.deepEqual(counting,['Seven','Five','Two']);checks++;
 await page.locator('#sl-close').focus();
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.getElementById('sl-dialog').contains(document.activeElement)),true);checks++;
 await page.screenshot({path:`${output}/games-${width}.png`});
 await page.locator('[data-slgame="Dallas Cowboys@Philadelphia Eagles"]').click();
 await page.waitForSelector('[data-slmarket="pass_int"]');
 await page.waitForFunction(()=>!!slPhotoIndex);
 const photo=page.locator('[data-slportrait="Jalen Hurts"] img').first();
 assert.match(await photo.getAttribute('src'),/4040715\.png/);checks++;
 await photo.evaluate(img=>img.dispatchEvent(new Event('error')));
 assert.equal(await page.locator('[data-slportrait="Jalen Hurts"]').first().innerText(),'JH');checks++;
 const photoSafety=await page.evaluate(()=>{
  const previous=slPhotoIndex;
  slPhotoIndex=new Map([['duplicate',[{id:'1',photo:'https://a.espncdn.com/one.png'},{id:'2',photo:'https://a.espncdn.com/two.png'}]],['unsafe',[{id:'3',photo:'https://example.com/photo.png'}]]]);
  const result=[slPlayerPhoto('Duplicate'),slPlayerPhoto('Unsafe'),slPlayerPhoto('Unknown')];slPhotoIndex=previous;return result;
 });assert.deepEqual(photoSafety,[null,null,null]);checks++;

 assert.equal(await page.locator('[data-slmarket]').count(),14);checks++;
 await page.locator('#sl-search').fill('nobody');assert.equal(await page.locator('#sl-no-results').isVisible(),true);checks++;
 await page.locator('#sl-search').fill('hurts');assert.equal(await page.locator('.sl-prop-row:visible').count(),13);checks++;
 for(const market of Object.keys(PROP_DEFS)){
  await page.locator(`[data-slmarket="${market}"]`).click();
  // The first side button is FanDuel's (books render FD then DK); its line and
  // odds come from the same book — never combined.
  await page.locator('[data-slchoose]').first().click();
  assert.equal(await page.locator('#sl-lock').isEnabled(),true);checks++;
  await page.locator('#sl-lock').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
  const pick=writes.at(-1).picks[0].prop;assert.equal(pick.market,market);assert.equal(pick.book,'fanduel');assert.equal(pick.line,market==='anytime_td'?null:39.5);checks+=3;
  await page.locator('#sl-repick').click();
 }
 // Locking DraftKings' under pairs DK's line (40.5) with DK's under odds (-125),
 // proving each book keeps its own line/odds combo.
 await page.locator('[data-slmarket="rush_yds"]').click();
 await page.locator('[data-slchoose$=":under:draftkings"]').click();
 const dkUnder=await page.evaluate(()=>slPropSel(slMarkets.find(m=>m.market==='rush_yds'),slMarkets.find(m=>m.market==='rush_yds').players[0]));
 assert.equal(dkUnder.book,'draftkings');assert.equal(dkUnder.line,40.5);assert.equal(dkUnder.price,-125);checks+=3;
 await page.locator('[data-slchoose$=":under:fanduel"]').click();
 const fdUnder=await page.evaluate(()=>slPropSel(slMarkets.find(m=>m.market==='rush_yds'),slMarkets.find(m=>m.market==='rush_yds').players[0]));
 assert.equal(fdUnder.book,'fanduel');assert.equal(fdUnder.line,39.5);assert.equal(fdUnder.price,-110);checks+=3;
 assert.equal(await page.locator('#sl-dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1),true);checks++;
 await page.waitForFunction(()=>{const img=document.querySelector('[data-slportrait="Jalen Hurts"] img');return img?.complete&&img.naturalWidth>0;});
 await page.screenshot({path:`${output}/props-${width}.png`});
 await page.evaluate(()=>{
  const m=slMarkets.find(x=>x.market==='rush_yds');window.originalRushPlayers=m.players;
  const player=(name,line)=>({...m.players[0],player:name,line,alts:[],fanduel:{line,over:-115,under:-110},draftkings:{line,over:-105,under:-125}});
  m.players=[m.players[0],player('Saquon Barkley',79.5),player('Dak Prescott',12.5)];slSearch='';refreshSuperLockEditor();
 });
 assert.deepEqual(await page.locator('.sl-player-heading strong').allTextContents(),['Saquon Barkley','Jalen Hurts','Dak Prescott']);checks++;
 await page.locator('[data-slchoose]').first().click();
 assert.equal(await page.evaluate(()=>slDraft.player),'Saquon Barkley');checks++;
 assert.equal(await page.locator('[data-slchoose]').first().getAttribute('data-slchoose'),'5:1:over:fanduel');checks++;
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-slportrait] img')).every(img=>img.complete&&img.naturalWidth>0));
 await page.screenshot({path:`${output}/yardage-${width}.png`});
 await page.evaluate(()=>{slMarkets.find(x=>x.market==='rush_yds').players=window.originalRushPlayers;slDraft={market:'rush_yds',player:'Jalen Hurts',side:'under',book:'fanduel',line:null};slSearch='hurts';refreshSuperLockEditor();});
 await page.locator('.sl-alt-wrap summary').click();await page.locator('[data-slchoose$=":fanduel:50.5"]').click();
 rejectSave=true;await page.locator('#sl-lock').click();await page.waitForFunction(()=>document.getElementById('mycard-sl-msg')?.textContent.includes('NO LONGER'));
 assert.equal(await page.locator('#sl-lock').isEnabled(),true);checks++;
 rejectSave=false;await page.locator('#sl-lock').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
 assert.equal(writes.at(-1).picks[0].prop.line,50.5);checks++;
 await page.locator('#sl-repick').click();await page.locator('[data-sltab="lines"]').click();await page.locator('[data-slmarket="__total__"]').click();
 // Both books render their own total row (FD 47.5, DK 48.5); locking DK keeps DK's line+odds.
 assert.equal(await page.locator('[data-slside^="over:"]').count(),2);checks++;
 await page.locator('[data-slside="over:draftkings"]').click();
 await page.locator('#sl-lock-line').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
 const dkPick=writes.at(-1).picks[0].line_pick;assert.equal(dkPick.bet,'Over');assert.equal(dkPick.book,'draftkings');assert.equal(dkPick.line,48.5);assert.equal(dkPick.price,-108);checks+=4;
 await page.locator('#sl-repick').click();await page.locator('[data-sltab="lines"]').click();await page.locator('[data-slmarket="__total__"]').click();await page.locator('[data-slside="over:fanduel"]').click();await page.locator('#sl-lock-line').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
 const linePick=writes.at(-1).picks[0].line_pick;assert.equal(linePick.bet,'Over');assert.equal(linePick.book,'fanduel');assert.equal(linePick.line,47.5);assert.equal(linePick.price,-110);checks+=4;
 await page.locator('#sl-repick').click();await page.locator('[data-slmode="custom"]').click();await page.locator('#mycard-superlock').fill('Custom pick');await page.locator('#mycard-sl-price').fill('-130');await page.locator('#mycard-sl-save').click();assert.equal(await page.locator('#sl-dialog').evaluate(d=>d.open),true);checks++;
 await page.locator('#mycard-sl-price').fill('150');await page.evaluate(()=>refreshSuperLockEditor());assert.equal(await page.locator('#mycard-superlock').inputValue(),'Custom pick');assert.equal(await page.locator('#mycard-sl-price').inputValue(),'150');checks+=2;await page.locator('#mycard-sl-save').click();await page.waitForSelector('#sl-dialog',{state:'detached'});assert.equal(writes.at(-1).picks[0].price,150);checks++;
 await page.locator('#sl-repick').click();await page.keyboard.press('Escape');await page.waitForSelector('#sl-dialog',{state:'detached'});assert.equal(await page.locator('#sl-repick').evaluate(e=>e===document.activeElement),true);checks++;
 assert.deepEqual(errors,[]);checks++;console.log(`${width}px passed`);await page.close();
}
await browser.close();server.close();console.log(`${checks} Super Lock interaction checks passed`);
