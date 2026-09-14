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
  const clinch=await page.evaluate(()=>{
   DATA={members:{},seasons:{}};
   const results={Mason:['W','W','W','L','W'],Chris:['W','W','W','W','L'],Brayden:['W','W','W','L',null]};
   const prices={Mason:-113,Chris:190,Brayden:-120};
   const rows=Object.keys(results).flatMap(member_name=>BET_TYPES_ORDER.map((bet_type,i)=>({member_name,season:2026,week:1,bet_type,result:results[member_name][i],price:prices[member_name],pick_text:bet_type+' fixture'})));
   mergeLiveSeason(rows);
   const d=rulesWeeklyDecision('2026',1,true);
   state.warRoom={season:2026,week:1,anyLive:true,recap:{complete:d.complete,clinched:d.clinched,winner:d.winner},members:d.ranked.map(e=>({member_id:e.id,name:e.name,week_rank:e.rank,week_tied:e.tied,tiebreak:e.tiebreak,live:{W:e.W,L:e.L,fW:e.W,fL:e.L,pending:e.pending},picks:[]}))};
   document.getElementById('root').innerHTML=renderRecapCard(state.warRoom)+renderStandingsWeek();
   return {winner:DATA.seasons['2026'].weeklyWinners['1'],complete:d.complete,clinched:d.clinched};
  });
  assert.deepEqual(clinch,{winner:'Mason',complete:false,clinched:true});
  assert.match(await page.locator('.rc-headline').innerText(),/Mason clinched Week 1/);
  assert.match(await page.locator('.week-member-row').first().innerText(),/Mason.*Clinched/s);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(tmpdir(),`weekly-clinch-${width}.png`),fullPage:true});
  console.log(`PASS ${width}px: early clinch appears in season winners, Live recap and This Week`);
  await page.close();
 }
} finally {await browser.close();}
