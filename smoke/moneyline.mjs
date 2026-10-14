import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSharp,espnDraftKingsRows} from '../functions/_shared/odds-providers.js';
import {resolvePickResult} from '../functions/_shared/grader.js';
import {livePickStatus} from '../functions/api/warroom.js';
import {canonicalMoneylineText} from '../functions/_shared/moneyline.js';
import {verifiedGames} from '../functions/_shared/quote-freshness.js';
import {quarantineImplausibleMarkets} from '../functions/api/odds.js';
const updated='2026-10-14T20:00:00.000Z', old='2026-10-14T19:00:00.000Z';
const game={away:'Chicago Bears',home:'Green Bay Packers',kickoff:'2026-10-18T17:00:00Z'};
const rows=(extra={})=>['away','home'].map((side,i)=>({event_id:'event1',home_team:game.home,away_team:game.away,
 event_start_time:game.kickoff,sportsbook:'fanduel',market_type:'moneyline',selection_type:side,
 odds_american:i?-145:125,timestamp:updated,is_main_line:true,...extra}));

test('Sharp two-way moneylines survive without spread/total thresholds',()=>{
 const g=normalizeSharp(rows())[0];
 assert.deepEqual(g.books.fanduel.moneyline,{awayPrice:125,homePrice:-145,updated});
 assert.equal(g.books.fanduel.spread,null);assert.equal(g.books.fanduel.total,null);
});
test('derivative, suspended, stale, invalid and three-way prices cannot become a full-game ML',()=>{
 for(const extra of [{market_type:'1st_half_moneyline'},{market_type:'three_way_moneyline'},
   {is_player_prop:true},{is_active:false},{is_stale_pregame_price:true},{odds_american:null},
   {odds_american:0},{odds_american:95},{odds_american:101.5},{timestamp:null},{is_alternate_line:true}])
   assert.equal(normalizeSharp(rows(extra)).length,0,JSON.stringify(extra));
 assert.equal(normalizeSharp(rows().concat({...rows()[0],selection_type:'draw'})).length,0);
 assert.equal(normalizeSharp(rows().concat({...rows()[0],odds_american:130})).length,0);
});
test('older side retains its age even with a fresh opposing quote/book',()=>{
 const source=rows();source[0].timestamp=old;
 const g=normalizeSharp(source)[0];
 assert.equal(g.books.fanduel.moneyline.updated,old);
 assert.equal(verifiedGames({games:[g]},Date.parse(updated))[0].books.fanduel.moneyline,null);
 assert.equal(verifiedGames({games:normalizeSharp(rows())},Date.parse(updated))[0].books.fanduel.moneyline.awayPrice,125);
});
test('invalid ML in persisted payload is quarantined without losing other markets',()=>{
 const payload={games:[{...game,books:{fanduel:{moneyline:{homePrice:0,awayPrice:125},total:{point:44.5}}}}]};
 const clean=quarantineImplausibleMarkets(payload).games[0].books.fanduel;
 assert.equal(clean.moneyline,null);assert.equal(clean.total.point,44.5);
});
test('ESPN supplements only named DraftKings current moneyline prices',()=>{
 const event={id:'1',date:game.kickoff,competitions:[{competitors:[{homeAway:'home',team:{displayName:game.home}},
 {homeAway:'away',team:{displayName:game.away}}],odds:[{provider:{id:'100',name:'DraftKings'},
 moneyline:{home:{close:{odds:'-140'},open:{odds:'-900'}},away:{close:{odds:'+120'}}}}]}]};
 const extra=espnDraftKingsRows([event],[{...game,id:'event1',books:{}}],updated,Date.parse(updated));
 assert.deepEqual(normalizeSharp(extra)[0].books.draftkings.moneyline,{homePrice:-140,awayPrice:120,updated});
 event.competitions[0].odds[0].provider.name='Consensus';
 assert.deepEqual(espnDraftKingsRows([event],[{...game,books:{}}],updated,Date.parse(updated)),[]);
});
test('structured ML routes final wins/losses/ties, never live projections or player boxscores',async()=>{
 const p={bet_type:'Super Lock',side:'away',pick_text:'Chicago Bears ML',prop_meta:{kind:'moneyline'}};
 const final={...game,state:'post',status:'final',away_score:7,home_score:31};
 const noBox=()=>{throw Error('Moneylines must not fetch player stats');};
 assert.equal(await resolvePickResult(p,final,noBox),'L');
 assert.equal(livePickStatus(p,final).status,'lose');
 assert.equal(await resolvePickResult({...p,side:'home',pick_text:'Green Bay Packers ML'},final,noBox),'W');
 assert.equal(await resolvePickResult(p,{...final,home_score:7},noBox),'P');
 for(const ev of [{...final,state:'in',status:'in'}, {...final,home_score:null}, {...final,home_score:NaN}])
   assert.equal(await resolvePickResult(p,ev,noBox),null);
 assert.equal(livePickStatus(p,{...final,state:'in'}).status,'pending');
 assert.equal(await resolvePickResult({...p,side:'home'},final,noBox),null);
 assert.equal(await resolvePickResult({...p,prop_meta:null},final,noBox),null);
});
test('custom shorthand canonicalizes for same-team claims but never interprets period bets',()=>{
 for(const text of ['Bears ML','CHI moneyline','Chicago Bears Money Line -120 DK'])
   assert.equal(canonicalMoneylineText(text),'Chicago Bears ML');
 for(const text of ['Bears first half ML','Chicago Bears +3.5','Jared ML'])
   assert.equal(canonicalMoneylineText(text),null);
});
