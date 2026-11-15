import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {loadChromium} from './playwright.mjs';
const server=createServer((req,res)=>{
 try {
  const path=req.url.split('?')[0];
  res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.json')?'application/json':'text/html');
  res.end(readFileSync(new URL('../public'+(path==='/'?'/index.html':path),import.meta.url)));
 } catch {res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await(await loadChromium()).launch();
const expected='Seahawks -3.5\nPackers +2.5\nBroncos/49ers o46.5\nLions/Bills u53.5\nSuper Lock: Rashee Rice over 63.5 receiving yards';
try {for(const width of [375,390,1440]) {
 const context=await browser.newContext({viewport:{width,height:920},permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>route.fulfill({json:{}}));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.evaluate(()=>{
  state.user={id:5,name:'Jacob'};state.myCardOpen=true;state.view='thisweek';
  state.serverConfig={season:2026,week:10,cutoff:'2026-11-15T18:00Z'};
  state.thisWeekData={games:[],source:'sharpapi'};
  currentMyPicks={
   Under:{pick_text:'Detroit Lions / Buffalo Bills U53.5',game_key:'Detroit Lions@Buffalo Bills',line:'53.5',side:'under'},
   'Super Lock':{pick_text:'Rashee Rice over 63.5 receiving yards',price:150},
   Dog:{pick_text:'Green Bay Packers +2.5',line:-2.5,side:'dog',book:'draftkings'},
   Over:{pick_text:'Denver Broncos / San Francisco 49ers O46.5',game_key:'Denver Broncos@San Francisco 49ers',line:46.5,side:'over'},
   Favorite:{pick_text:'Seattle Seahawks -3.5',line:-3.5,side:'fav'}
  };
  document.getElementById('root').innerHTML=renderThisWeek();refreshMyCard();
 });
 assert.equal(await page.evaluate(()=>buildMyPicksText()),expected);
 await page.locator('#mycard-copy').click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected,'actual clipboard matches saved picks in requested order');
 assert.equal(await page.locator('#mycard-copy-status').innerText(),'Copied!');
 assert.equal(await page.locator('#my-card').evaluate(e=>e.open),true,'copy does not collapse card');
 assert.ok((await page.locator('#mycard-copy').boundingBox()).height>=44);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('#my-card').screenshot({path:`/tmp/copy-picks-${width}.png`});
 // Live quote moves cannot affect copied selections.
 await page.evaluate(()=>{state.thisWeekData.games=[{away:'Detroit Lions',home:'Buffalo Bills',books:{fanduel:{total:{point:54.5}}}},{away:'Denver Broncos',home:'San Francisco 49ers',books:{draftkings:{total:{point:49}}}}];refreshMyCard();});
 await page.locator('#mycard-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected);
 // Every Super Lock type stays complete, including custom text and long player names.
 for(const text of ['Chicago Bears ML','Philadelphia Eagles -2.5','Dallas Cowboys / Philadelphia Eagles U47.5','Amon-Ra St. Brown 80+ receiving yards','Kenneth Walker III anytime touchdown','Custom: first touchdown & 100+ yards']) {
  assert.equal(await page.evaluate(text=>buildMyPicksText({'Super Lock':{pick_text:text}}),text),'Super Lock: '+text);
 }
 assert.equal(await page.evaluate(()=>buildMyPicksText({Dog:{text:'Green Bay Packers +2.5'},Under:{text:'Detroit Lions / Buffalo Bills U53.5'},Favorite:{text:'No pick',missing:true}})),'Packers +2.5\nLions/Bills u53.5');
 assert.equal(await page.evaluate(()=>buildMyPicksText({Favorite:{pick_text:'Chicago Bears 0',line:0}})),'Bears 0');
 await page.evaluate(()=>{currentMyPicks={};refreshMyCard();});assert.equal(await page.locator('#mycard-copy').isDisabled(),true);
 await page.evaluate(()=>{currentMyPicks={'Super Lock':{pick_text:'Chicago Bears ML'}};refreshMyCard();});
 await page.locator('#mycard-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Super Lock: Chicago Bears ML');
 // Refusal must never claim success. Fallback also reports execCommand failure.
 await page.evaluate(()=>{window.savedClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('denied'))}});});
 await page.locator('#mycard-copy').click();assert.match(await page.locator('#mycard-copy-status').innerText(),/Couldn’t copy/);
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});window.savedExec=document.execCommand;document.execCommand=()=>false;});
 await page.locator('#mycard-copy').click();assert.match(await page.locator('#mycard-copy-status').innerText(),/Couldn’t copy/);assert.equal(await page.locator('textarea').count(),0);
 await page.evaluate(()=>{document.execCommand=command=>{window.fallbackText=document.querySelector('textarea').value;return command==='copy';};});
 await page.locator('#mycard-copy').click();assert.equal(await page.evaluate(()=>window.fallbackText),'Super Lock: Chicago Bears ML');assert.equal(await page.locator('#mycard-copy-status').innerText(),'Copied!');assert.equal(await page.locator('#mycard-copy').evaluate(e=>e===document.activeElement),true);
 await page.locator('#my-card > summary').click();assert.equal(await page.locator('#my-card').evaluate(e=>e.open),false);
 await page.locator('#my-card > summary').click();assert.equal(await page.locator('#my-card').evaluate(e=>e.open),true);
 await page.evaluate(()=>{state.user=null;document.getElementById('root').innerHTML=renderMyCardPanel();});assert.equal(await page.locator('#mycard-copy').count(),0);
 assert.deepEqual(errors,[]);console.log(`PASS Copy Picks ${width}px: actual clipboard, saved lines, five types, partial/empty cards, failure/fallback, layout and disclosure`);
 await context.close();
}} finally {await browser.close();server.close();}
