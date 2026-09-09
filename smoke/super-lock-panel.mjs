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
  const books={fanduel:{spread:{fav:'Philadelphia Eagles',line:-3.5,favPrice:-110,dogPrice:-110},total:{point:47.5,overPrice:-110,underPrice:-110}}};
  state.thisWeekData={games:[{away:'Dallas Cowboys',home:'Philadelphia Eagles',kickoff:'2026-09-13T17:00Z',books},{away:'Chicago Bears',home:'Carolina Panthers',kickoff:'2026-09-13T20:25Z',books},{away:'Buffalo Bills',home:'New York Jets',kickoff:'2026-09-08T17:00Z',books}],source:'sharpapi'};
  currentMyPicks={};state.myCardOpen=true;document.getElementById('root').innerHTML=renderThisWeek();refreshSuperLockEditor();
 },JSON.parse(readFileSync(dir+'public/data/seasons.json','utf8')));
 await page.locator('#sl-open').click();
 assert.equal(await page.locator('#sl-dialog').evaluate(d=>d.open),true);checks++;
 assert.equal(await page.locator('[data-slgame]:disabled').count(),1);checks++;
 await page.screenshot({path:`${output}/games-${width}.png`});
 await page.locator('[data-slgame="Dallas Cowboys@Philadelphia Eagles"]').click();
 await page.waitForSelector('[data-slmarket="pass_int"]');
 assert.equal(await page.locator('[data-slmarket]').count(),14);checks++;
 await page.locator('#sl-search').fill('nobody');assert.equal(await page.locator('#sl-no-results').isVisible(),true);checks++;
 await page.locator('#sl-search').fill('hurts');assert.equal(await page.locator('.sl-prop-row:visible').count(),13);checks++;
 for(const market of Object.keys(PROP_DEFS)){
  await page.locator(`[data-slmarket="${market}"]`).click();
  await page.locator('[data-slchoose]').first().click();
  assert.equal(await page.locator('#sl-lock').isEnabled(),true);checks++;
  await page.locator('#sl-lock').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
  const pick=writes.at(-1).picks[0].prop;assert.equal(pick.market,market);assert.equal(pick.book,'draftkings');assert.equal(pick.line,market==='anytime_td'?null:40.5);checks+=3;
  await page.locator('#sl-repick').click();
 }
 await page.locator('[data-slmarket="rush_yds"]').click();
 await page.locator('[data-slchoose$=":under"]').click();
 assert.equal(await page.evaluate(()=>slPropSel(slMarkets.find(m=>m.market==='rush_yds'),slMarkets.find(m=>m.market==='rush_yds').players[0]).book),'fanduel');checks++;
 await page.screenshot({path:`${output}/props-${width}.png`});
 await page.locator('.sl-alt-wrap summary').click();await page.locator('[data-slchoose$=":50.5"]').click();
 rejectSave=true;await page.locator('#sl-lock').click();await page.waitForFunction(()=>document.getElementById('mycard-sl-msg')?.textContent.includes('NO LONGER'));
 assert.equal(await page.locator('#sl-lock').isEnabled(),true);checks++;
 rejectSave=false;await page.locator('#sl-lock').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
 assert.equal(writes.at(-1).picks[0].prop.line,50.5);checks++;
 await page.locator('#sl-repick').click();await page.locator('[data-sltab="lines"]').click();await page.locator('[data-slmarket="__total__"]').click();await page.locator('[data-slside="over"]').click();await page.locator('#sl-lock-line').click();await page.waitForSelector('#sl-dialog',{state:'detached'});
 assert.equal(writes.at(-1).picks[0].line_pick.bet,'Over');checks++;
 await page.locator('#sl-repick').click();await page.locator('[data-slmode="custom"]').click();await page.locator('#mycard-superlock').fill('Custom pick');await page.locator('#mycard-sl-price').fill('-130');await page.locator('#mycard-sl-save').click();assert.equal(await page.locator('#sl-dialog').evaluate(d=>d.open),true);checks++;
 await page.locator('#mycard-sl-price').fill('150');await page.locator('#mycard-sl-save').click();await page.waitForSelector('#sl-dialog',{state:'detached'});assert.equal(writes.at(-1).picks[0].price,150);checks++;
 await page.locator('#sl-repick').click();await page.keyboard.press('Escape');await page.waitForSelector('#sl-dialog',{state:'detached'});assert.equal(await page.locator('#sl-repick').evaluate(e=>e===document.activeElement),true);checks++;
 assert.deepEqual(errors,[]);checks++;console.log(`${width}px passed`);await page.close();
}
await browser.close();server.close();console.log(`${checks} Super Lock interaction checks passed`);
