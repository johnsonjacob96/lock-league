import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadChromium} from './playwright.mjs';
const browser=await(await loadChromium()).launch();
try{for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(new URL('../public/index.html',import.meta.url).href);
 await page.evaluate(()=>{
  state.user={id:1,name:'Test'};state.myPicksWeek=2;
  const game={away:'Green Bay Packers',home:'Chicago Bears',kickoff:new Date(Date.now()+86400000).toISOString(),books:{fanduel:{spread:{fav:'Chicago Bears',line:-1.5,favPrice:-110,dogPrice:-110},total:{point:44.5,overPrice:-110,underPrice:-110}},draftkings:{spread:{fav:'Chicago Bears',line:-2.5,favPrice:-110,dogPrice:-110},total:{point:45.5,overPrice:-110,underPrice:-110}}}};
  state.thisWeekData={games:[game]};
  currentMyPicks={Dog:{pick_text:'Green Bay Packers +2.5',game_key:'Green Bay Packers@Chicago Bears',side:'dog',line:-2.5,price:-110,book:'draftkings'}};
  document.getElementById('root').innerHTML='<div style="max-width:460px">'+renderGameCard(game)+'</div>';bindGameCard(document.querySelector('.game-card'));markPickedButtons(currentMyPicks);
 });
 const strip=page.locator('.game-saved-picks');assert.match(await strip.innerText(),/DK[\s\S]*Packers \+2.5/);
 assert.equal(await page.locator('.game-card').getAttribute('data-book'),'fanduel');assert.equal(await page.locator('.pick-btn.picked').count(),0);
 await page.locator('.book-toggle[data-book=draftkings]').click();assert.equal(await page.locator('.pick-btn.picked').count(),1);
 await page.locator('.book-toggle[data-book=fanduel]').click();assert.match(await strip.innerText(),/Packers \+2.5/);
 await page.evaluate(()=>{const g=state.thisWeekData.games[0];g.books.draftkings.spread.line=-1.5;switchBook('Green Bay Packers@Chicago Bears','draftkings');});
 assert.equal(await page.locator('.pick-btn.picked').count(),0);assert.match(await strip.innerText(),/Packers \+2.5/);
 await page.evaluate(()=>{currentMyPicks['Super Lock']={pick_text:'Jordan Love over 250.5 passing yards',game_key:'Green Bay Packers@Chicago Bears',book:'fanduel'};refreshMyCard();});
 assert.equal(await page.locator('.game-saved-pick').count(),2);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('.game-card').screenshot({path:join(tmpdir(),`game-saved-picks-${width}.png`)});
 await page.evaluate(()=>{const g=state.thisWeekData.games[0];g.books={};g.kickoff=new Date(Date.now()-3600000).toISOString();switchBook('Green Bay Packers@Chicago Bears','fanduel');});
 assert.equal(await page.locator('.game-saved-pick').count(),2,'saved picks remain without available quotes or after kickoff');
 await page.evaluate(()=>{currentMyPicks.Dog.game_key='Other@Game';refreshMyCard();});assert.equal(await page.locator('.game-saved-pick').count(),1,'replacement removes the old game marker');
 await page.evaluate(()=>{currentMyPicks={};refreshMyCard();});assert.equal(await strip.count(),0);
 await page.evaluate(()=>{currentMyPicks={Dog:{game_key:'Green Bay Packers@Chicago Bears',pick_text:'Hidden'}};state.user=null;markPickedButtons(currentMyPicks);});assert.equal(await strip.count(),0);
 assert.deepEqual(errors,[]);console.log(`PASS saved game picks ${width}px: book switches, moved quotes, Super Lock, missing markets, removal and sign-out`);await page.close();
}}finally{await browser.close();}
