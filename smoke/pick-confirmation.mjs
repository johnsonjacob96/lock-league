// Exercise replacement confirmation with intercepted writes; never submit real picks.
import assert from 'node:assert/strict';
import {normalizeSharpProps} from '../functions/_shared/props.js';
import {menuForGame} from '../functions/api/props.js';
import {sharpPropRows} from './fixtures.mjs';
import {loadChromium} from './playwright.mjs';
const markets=menuForGame(normalizeSharpProps(sharpPropRows()),'New England Patriots','Seattle Seahawks');
const browser=await (await loadChromium()).launch();
try {
 for(const width of [390,1440]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.goto(new URL('../public/index.html',import.meta.url).href);
  await page.evaluate(()=>{
   state.user={name:'Test'};state.myPicksWeek=1;
   window.refreshMyCard=()=>{};
   window.writes=[];
   window.fetch=async(url,options)=>{
    if(options?.method==='POST')writes.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({picks:writes.at(-1)?.picks || []})};
   };
   currentMyPicks={Dog:{pick_text:'Green Bay Packers +2.5',game_key:'GB@CHI',side:'dog',line:2.5,book:'fanduel',price:-110}};
   document.body.innerHTML='<button id="pick" class="pick-btn picked" data-bet="Dog" data-game="GB@CHI" data-side="dog" data-line="1.5" data-book="fanduel" data-price="-105" data-text="Green Bay Packers +1.5">Packers +1.5</button>';
   document.getElementById('pick').onclick=e=>{window.pendingPick=clickPickButton(e.currentTarget)};
   markPickedButtons(currentMyPicks);
  });
  assert.equal(await page.locator('#pick').evaluate(b=>b.classList.contains('picked')),false);
  await page.locator('#pick').click();
  await page.locator('dialog[open]').waitFor();
  assert.match(await page.locator('dialog').innerText(),/Packers \+2\.5[\s\S]*Packers \+1\.5/);
  assert.equal(await page.evaluate(()=>writes.length),0);
  assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-keep')),true);
  assert.equal(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true);
  await page.screenshot({path:`/private/tmp/pick-confirmation-${width}.png`});
  await page.locator('[data-keep]').click();
  assert.equal(await page.evaluate(()=>currentMyPicks.Dog.line),2.5);
  assert.equal(await page.evaluate(()=>writes.length),0);
  await page.locator('#pick').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>writes.length),0);
  await page.locator('#pick').click();
  // A second invocation while the first confirmation is open cannot submit.
  await page.evaluate(()=>clickPickButton(document.getElementById('pick')));
  assert.equal(await page.locator('dialog').count(),1);
  await page.locator('[data-change]').click();
  await page.evaluate(()=>pendingPick);
  assert.equal(await page.evaluate(()=>writes.length),1);
  assert.equal(await page.evaluate(()=>currentMyPicks.Dog.line),1.5);
  assert.equal(await page.evaluate(()=>writes[0].picks[0].expected_quote.price),-105);
  // Initial selections save directly, without a redundant confirmation.
  await page.evaluate(()=>{currentMyPicks={};document.getElementById('pick').classList.remove('picked')});
  await page.locator('#pick').click();await page.evaluate(()=>pendingPick);
  assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.evaluate(()=>writes.length),2);
  // All three Super Lock entry paths must offer the same comparison before POST.
  await page.evaluate(()=>{
   currentMyPicks={'Super Lock':{pick_text:'Old player over 50.5 yards',price:120,book:'draftkings'}};
  });
  // Supply valid custom odds, then exercise the replacement path.
  await page.evaluate(()=>{
   document.body.insertAdjacentHTML('beforeend','<input id="mycard-sl-price" value="110">');
   window.pendingSl=saveSuperLockText('New player over 60.5 yards');
  });
  await page.locator('dialog[open]').waitFor();
  assert.match(await page.locator('dialog').innerText(),/Old player[\s\S]*New player/);
  await page.locator('[data-keep]').click();await page.evaluate(()=>pendingSl);
  assert.equal(await page.evaluate(()=>writes.length),2);
  await page.evaluate(mk=>{
   superLockState.gameKey='New England Patriots@Seattle Seahawks';
   superLockState.markets=mk;
   const market=mk.find(m=>m.kind!=='yes');
   const player=market.players[0];
   const quote=SL_BOOKS.map(book=>slBookSide(player,book,'over')).find(Boolean);
   superLockState.draft={market:market.market,player:player.player,side:'over',book:quote.book,line:null};
   window.pendingSl=lockStructuredProp();
  },markets);
  await page.locator('dialog[open]').waitFor();
  await page.locator('[data-keep]').click();await page.evaluate(()=>pendingSl);
  assert.equal(await page.evaluate(()=>writes.length),2);
  await page.evaluate(()=>{
   state.thisWeekData={games:[{away:'New England Patriots',home:'Seattle Seahawks',books:{fanduel:{spread:{fav:'Seattle Seahawks',line:-3.5,favPrice:-110,dogPrice:-110}}}}]};
   superLockState.draft={side:'dog',book:'fanduel'};
   window.pendingSl=lockGameLine();
  });
  await page.locator('dialog[open]').waitFor();
  await page.locator('[data-keep]').click();await page.evaluate(()=>pendingSl);
  assert.equal(await page.evaluate(()=>writes.length),2);
  console.log(`PASS ${width}px: moved line, comparison, cancel, Escape, focus, duplicate click, confirm payload, first pick, Super Lock cancellation`);
  await page.close();
 }
} finally {await browser.close()}
