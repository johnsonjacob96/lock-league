import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {loadChromium} from './playwright.mjs';
const browser=await (await loadChromium()).launch();
const shots='/tmp/lock-league-game-panel';mkdirSync(shots,{recursive:true});
try {
 for(const width of [375,768,1440]) {
  const page=await browser.newPage({viewport:{width,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',r=>r.fulfill({json:{}}));
  await page.goto(new URL('../public/index.html',import.meta.url).href,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{
   const key='Buffalo Bills@Detroit Lions';
   const data={found:true,state:'in',detail:'Q3 · 08:42',situation:'2nd & 7 at DET 34',away:{name:'Buffalo Bills',score:21},home:{name:'Detroit Lions',score:14},source_updated_at:new Date().toISOString(),stats_updated_at:new Date().toISOString(),players:[{name:'Josh Allen',markets:{rush_yds:{actual:24,unit:'rush yds'}}}],leaders:[{team:'BUF',rows:[{cat:'PASS',name:'J. Allen',line:'18/26, 214 YDS, 2 TD'},{cat:'RUSH',name:'J. Cook',line:'14 CAR, 86 YDS'},{cat:'REC',name:'K. Shakir',line:'5 REC, 72 YDS'}]},{team:'DET',rows:[{cat:'PASS',name:'J. Goff',line:'16/24, 186 YDS, 1 TD'},{cat:'RUSH',name:'J. Gibbs',line:'12 CAR, 68 YDS'},{cat:'REC',name:'A. St. Brown',line:'6 REC, 82 YDS'}]}]};
   const pick={game_key:key,pick_text:'Josh Allen Over 31.5 Rushing Yards',bet_type:'Super Lock',prop:{player:'Josh Allen',market:'rush_yds',side:'over',line:31.5}};
   wrGameCache[key]={data,ts:Date.now()};
   document.getElementById('root').innerHTML=`<div style="max-width:760px;margin:20px auto;padding:0 12px"><h1 style="font-family:Oswald;font-size:28px;margin-bottom:16px">LIVE GAME</h1>${wrGamePanel(pick)}</div>`;
  });
  await page.addStyleTag({content:'#mobile-nav{display:none!important}'});
  assert.equal(await page.locator('.wrg-lrow').count(),6);
  assert.equal(await page.locator('.wrg-logo').count(),2);
  assert.match(await page.locator('.wrg-track').innerText(),/24/);
  assert.equal(await page.locator('.wr-detail').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.locator('.wr-detail').screenshot({path:`${shots}/${width}.png`});
  for(const state of ['post','pre']) {
   await page.evaluate(state=>{const key='Buffalo Bills@Detroit Lions';wrGameCache[key].data.state=state;wrGameCache[key].data.leaders=[];wrGameCache[key].data.players=[];document.getElementById('root').innerHTML=wrGamePanel({game_key:key,pick_text:'BUF -3.5'});},state);
   assert.match(await page.locator('.wrg-pill').innerText(),state==='post'?/final/i:/scheduled/i);
  }
  assert.deepEqual(errors,[]);console.log(`${width}px: scoreboard, leaders, tracking, empty and final states passed`);await page.close();
 }
} finally {await browser.close();}
