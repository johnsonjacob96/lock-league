// Public-handler regression coverage: sharedFeed may return without its loader.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
let cached;
mock.module('../functions/_shared/feed-cache.js', { namedExports: {
  sharedFeed: async () => structuredClone(cached),
  providerFetch: async () => { throw Error('network forbidden'); },
} });
const { normalizeSharp } = await import('../functions/_shared/odds-providers.js');
const { onRequestGet } = await import('../functions/api/odds.js');
const { deriveGradable } = await import('../functions/api/picks.js');
const base = {away_team:'Miami Dolphins',home_team:'San Francisco 49ers',event_start_time:'2026-09-20T20:25Z',sportsbook:'draftkings',is_main_line:true};
const total = (market,point,extra={}) => ['over','under'].map(selection_type=>({...base,market_type:market,line:point,selection_type,odds_american:-110,...extra}));
test('only supported full-game markets enter main-line resolution',()=>{
  const derivatives=['h1_total_points','q1_total','home_total_points','total_tds','total_pass_attempts','player_total_points','unknown_total','first_half_total_points'];
  for(const market of derivatives){
    assert.deepEqual(normalizeSharp(total(market,28.5)),[],market);
    const game=normalizeSharp([...total('total_points',45.5,{is_main_line:false}),...total(market,28.5)])[0];
    assert.equal(game.books.draftkings.total.point,45.5,market);
    assert.equal(deriveGradable(game,'Over','over','draftkings').line,45.5);
  }
  for(const market of ['h1_point_spread','q1_handicap','player_handicap']){
    assert.deepEqual(normalizeSharp([{...base,market_type:market,line:-3.5,selection_type:'home',odds_american:-110}]),[]);
  }
});
test('supported full-game aliases preserve each sportsbook quote',()=>{
  for(const market of ['total_points','points_total','total','totals','over_under','Over/Under','Full Game Total','full_game_total_points']){
    const game=normalizeSharp([...total(market,45.5),...total(market,46.5,{sportsbook:'fanduel'})])[0];
    assert.equal(game.books.draftkings.total.point,45.5,market);
    assert.equal(game.books.fanduel.total.point,46.5,market);
  }
  for(const market of ['point_spread','spread','spreads','handicap','Full Game Point Spread','full_game_spread']){
    const game=normalizeSharp([{...base,market_type:market,line:-3.5,selection_type:'home',odds_american:-110},{...base,market_type:market,line:3.5,selection_type:'away',odds_american:-110}])[0];
    assert.equal(game.books.draftkings.spread.line,-3.5,market);
  }
});
test('unknown selection is not invented as an under',()=>{
  assert.deepEqual(normalizeSharp(total('total_points',45.5,{selection_type:'other',selection:'Odd'})),[]);
});
for(const stale of [false,true])test(`public board sanitizes ${stale?'stale':'fresh'} shared cache before returning`,async()=>{
  const good={point:45.5,overPrice:-110,underPrice:-110};
  cached={source:'sharpapi',stale,live:!stale,games:[{home:base.home_team,away:base.away_team,books:{fanduel:{total:good},draftkings:{total:{point:9.5,overPrice:4000,underPrice:null},spread:{fav:base.home_team,line:-3.5,favPrice:-110,dogPrice:-110}}}}]};
  const response=await onRequestGet({request:new Request('https://test.invalid/api/odds'),env:{DATABASE_URL:'unused'},waitUntil(){}});
  assert.equal(response.status,200);
  const clean=await response.json();
  assert.equal(clean.stale,stale);
  assert.equal(clean.games[0].books.draftkings.total,null);
  assert.deepEqual(clean.games[0].books.fanduel.total,good);
  assert.equal(clean.games[0].books.draftkings.spread.line,-3.5);
  assert.equal(cached.games[0].books.draftkings.total.point,9.5);
  assert.equal(deriveGradable(cached.games[0],'Over','over','draftkings'),null);
});
