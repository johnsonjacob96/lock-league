import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadChromium} from './playwright.mjs';
const browser=await(await loadChromium()).launch();
try {
 for(const width of [390,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.goto(new URL('../public/index.html',import.meta.url).href);
  const result=await page.evaluate(()=>{
   DATA={members:{},seasons:{}};state.season='2026';state.user={name:'Jacob',id:5};
   state.serverConfig={season:2026,week:1,cutoff:'2026-09-01T00:00:00Z'};
   const rows=['Jacob','Jared'].flatMap((member_name,index)=>BET_TYPES_ORDER.map((bet_type,i)=>({
    member_name,season:2026,week:1,bet_type,result:['W','W','L','L','W'][i],price:bet_type==='Super Lock' ? (index?250:150) : -110,pick_text:bet_type+' fixture',
   })));
   mergeLiveSeason(rows);normalizeRecords(DATA);
   const decision=rulesWeeklyDecision('2026',1,true);
   const season=buildStandings('2026');
   state.warRoom={season:2026,week:1,revealed:true,anyLive:false,members:decision.ranked.map(e=>({
    member_id:e.id,name:e.name,week_rank:e.rank,week_tied:e.tied,tiebreak:e.tiebreak,
    live:{W:e.W,L:e.L,fW:e.W,fL:e.L,pending:0},picks:[],
   }))};
   const live=liveLeaderboardRows(state.warRoom),weekly=standingsWeekRows(state.warRoom.members);
   document.getElementById('root').innerHTML=renderStandings();
   return {winner:DATA.seasons['2026'].weeklyWinners['1'],season:season[0].name,live:live[0].member.name,weekly:weekly[0].m.name,
    rank:season[0].rank,reason:season[0].tiebreak,overflow:document.querySelector('.home-table').scrollWidth>document.querySelector('.home-table').clientWidth+1};
  });
  assert.deepEqual(result,{winner:'Jared',season:'Jared',live:'Jared',weekly:'Jared',rank:1,reason:'Total Super Lock odds',overflow:false});
  await page.screenshot({path:join(tmpdir(),`tiebreaks-season-${width}.png`),fullPage:true});
  await page.evaluate(()=>document.getElementById('root').innerHTML=renderLiveLeaderboard(state.warRoom));
  assert.match(await page.locator('.leader-rank').first().getAttribute('title'),/Longer Super Lock odds/);
  await page.screenshot({path:join(tmpdir(),`tiebreaks-week-${width}.png`),fullPage:true});
  console.log(`PASS ${width}px: weekly winner, season rank, Live rank, This Week rank and odds explanation agree`);
  await page.close();
 }
} finally {await browser.close();}
