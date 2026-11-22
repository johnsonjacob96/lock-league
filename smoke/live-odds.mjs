// Live chance to hit, from in-game odds rows shaped like SharpAPI's live feed
// (Seahawks @ Raiders at halftime, Nov 15: abbreviated team names, full
// alternate ladders, is_live: true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { normalizeLiveRows, liveHitChance, pickSpec } = await import('../functions/_shared/live-odds.js');
const { attachLiveChances } = await import('../functions/api/warroom.js');

const NOW = Date.parse('2026-11-15T22:24:00Z');
const at = '2026-11-15T22:23:50Z';
const row = (o) => ({ is_live: true, is_active: true, home_team: 'LV Raiders', away_team: 'SEA Seahawks', timestamp: at, sportsbook: 'draftkings', ...o });
const spread = (side, line, odds, book) => row({ market_type: 'point_spread', selection_type: side, line, odds_american: odds, ...(book ? { sportsbook: book } : {}) });
const total = (side, line, odds) => row({ market_type: 'total_points', selection_type: side, line, odds_american: odds });
const rows = [
  // Raiders +2.5 / Seahawks -2.5 and a ladder around it.
  spread('home', 2.5, -130), spread('away', -2.5, 110),
  spread('home', -3.5, 150), spread('away', 3.5, -180),
  spread('home', 9.5, -900), spread('away', -9.5, 600),
  spread('home', -15.5, 1400), // one-sided: no Seahawks +15.5 posted
  total('over', 40.5, -110), total('under', 40.5, -110),
  total('over', 43.5, 150), total('under', 43.5, -180),
  row({ market_type: 'moneyline', selection_type: 'home', line: null, odds_american: 120 }),
  row({ market_type: 'moneyline', selection_type: 'away', line: null, odds_american: -140 }),
  // A pregame row and a player prop never enter the live board.
  { ...spread('home', 6.5, -110, 'fanduel'), is_live: false },
  row({ market_type: 'player_receiving_yards', is_player_prop: true, selection_type: 'over', line: 49.5, odds_american: 270 }),
];
const games = normalizeLiveRows(rows);
const game = games['Seattle Seahawks@Las Vegas Raiders'];
const imp = x => x < 0 ? -x / (100 - x) : 100 / (100 + x);
// The power method, solved independently: the exponent k that makes both
// implied chances sum to 1.
const vigFree = (a, b) => {
  let lo = 1, hi = 50;
  for (let i = 0; i < 100; i++) { const k = (lo + hi) / 2; if (imp(a) ** k + imp(b) ** k > 1) lo = k; else hi = k; }
  return imp(a) ** lo / (imp(a) ** lo + imp(b) ** lo);
};

test('live rows normalize onto canonical game keys, live game lines only', () => {
  assert.deepEqual(Object.keys(games), ['Seattle Seahawks@Las Vegas Raiders']);
  assert.deepEqual(Object.keys(game.books), ['draftkings']);
  assert.equal(game.books.draftkings.spread.home[2.5], -130);
  assert.equal(game.books.draftkings.spread.home[6.5], undefined);
});

test('a spread pick on a posted line reads its vig-free live price', () => {
  const dog = liveHitChance({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5', side: 'dog', line: -2.5 }, game, NOW);
  assert.equal(dog.chance, Math.round(vigFree(-130, 110) * 1000) / 1000);
  assert.deepEqual(dog.books, ['draftkings']);
  const fav = liveHitChance({ bet_type: 'Favorite', pick_text: 'Seattle Seahawks -2.5', side: 'fav', line: -2.5 }, game, NOW);
  assert.ok(Math.abs(fav.chance + dog.chance - 1) < 0.002, 'the two sides of one line are complementary');
});

test('a locked line between posted lines interpolates; past the ladder holds the end', () => {
  const p = (text) => liveHitChance({ bet_type: 'Dog', pick_text: text }, game, NOW).chance;
  assert.ok(p('Las Vegas Raiders +6.5') > p('Las Vegas Raiders +2.5') && p('Las Vegas Raiders +6.5') < p('Las Vegas Raiders +9.5'));
  assert.equal(p('Las Vegas Raiders +20.5'), p('Las Vegas Raiders +9.5'));
});

test('totals, both directions, and moneyline Super Locks', () => {
  const over = liveHitChance({ bet_type: 'Over', side: 'over', line: '40.5' }, game, NOW).chance;
  const under = liveHitChance({ bet_type: 'Under', side: 'under', line: '40.5' }, game, NOW).chance;
  assert.equal(over, 0.5); assert.equal(under, 0.5);
  const over42 = liveHitChance({ bet_type: 'Over', side: 'over', line: 42 }, game, NOW).chance;
  assert.ok(over42 < 0.5 && over42 > vigFree(150, -180), 'a higher total is harder to go over');
  const slTotal = liveHitChance({ bet_type: 'Super Lock', side: 'under', line: 43.5, prop_meta: { kind: 'total', side: 'under', line: 43.5 } }, game, NOW).chance;
  assert.equal(slTotal, Math.round(vigFree(-180, 150) * 1000) / 1000);
  const ml = liveHitChance({ bet_type: 'Super Lock', side: 'home', prop_meta: JSON.stringify({ kind: 'moneyline', side: 'home' }) }, game, NOW).chance;
  assert.equal(ml, Math.round(vigFree(120, -140) * 1000) / 1000);
  const slSpread = liveHitChance({ bet_type: 'Super Lock', pick_text: 'Las Vegas Raiders +2.5', side: 'dog', prop: { kind: 'spread' } }, game, NOW).chance;
  assert.equal(slSpread, Math.round(vigFree(-130, 110) * 1000) / 1000);
});

// FanDuel's live Saints/Bears total, early 4th quarter Nov 22 (29 points in):
// Jacob's Under 49.5 read 90% when the book had it at -2500.
const bears = normalizeLiveRows([
  [38.5, -128, -104], [40.5, 142, -192], [43.5, 280, -420], [45.5, null, -700],
  [47.5, null, -1400], [48.5, 640, -1450], [49.5, 850, -2500], [50.5, 1100, null], [52.5, 1400, null],
].flatMap(([line, over, under]) => [['over', over], ['under', under]].filter(([, o]) => o != null)
  .map(([side, odds]) => ({ is_live: true, sportsbook: 'fanduel', market_type: 'total_points', selection_type: side, line, odds_american: odds,
    home_team: 'CHI Bears', away_team: 'NO Saints', timestamp: at }))))['New Orleans Saints@Chicago Bears'];
const under = (line) => liveHitChance({ bet_type: 'Under', side: 'under', line }, bears, NOW).chance;

test('a heavy favorite keeps its price: the margin comes off the longshot', () => {
  assert.equal(under(49.5), Math.round((1 - vigFree(850, -2500)) * 1000) / 1000);
  assert.ok(under(49.5) > 0.94, `Under 49.5 at -2500 reads ${under(49.5)}`);
  assert.ok(Math.abs(under(49.5) + liveHitChance({ bet_type: 'Over', side: 'over', line: 49.5 }, bears, NOW).chance - 1) < 0.002);
});

test('a one-sided quote counts, and a better line never reads worse', () => {
  // Only Under 45.5 -700 is posted (87.5% before the margin).
  assert.ok(under(45.5) > 0.84 && under(45.5) < 0.875, `Under 45.5 reads ${under(45.5)}`);
  const ladder = [38.5, 40.5, 42, 43.5, 45.5, 47.5, 48.5, 49.5, 50.5, 52.5, 60.5].map(under);
  assert.ok(ladder.every((c, i) => !i || c >= ladder[i - 1]), JSON.stringify(ladder));
});

test('no number for props, free text, unknown teams, or books that stopped pricing', () => {
  assert.equal(pickSpec({ bet_type: 'Super Lock', prop_meta: { market: 'rec_yds', player: 'X', side: 'over', line: 49.5 } }, game), null);
  assert.equal(pickSpec({ bet_type: 'Super Lock', pick_text: 'Raiders ML', prop_meta: null }, game), null);
  assert.equal(pickSpec({ bet_type: 'Super Lock', prop_meta: '{not json' }, game), null);
  assert.equal(liveHitChance({ bet_type: 'Dog', pick_text: 'Denver Broncos +3' }, game, NOW), null);
  assert.equal(liveHitChance({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5' }, game, NOW + 6 * 60000), null);
  assert.equal(liveHitChance({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5' }, undefined, NOW), null);
});

test('FanDuel and DraftKings average when both price the line', () => {
  const both = normalizeLiveRows([...rows, spread('home', 2.5, -110, 'fanduel'), spread('away', -2.5, -110, 'fanduel')]);
  const hit = liveHitChance({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5' }, both['Seattle Seahawks@Las Vegas Raiders'], NOW);
  assert.deepEqual(hit.books.sort(), ['draftkings', 'fanduel']);
  assert.equal(hit.chance, Math.round(((vigFree(-130, 110) + 0.5) / 2) * 1000) / 1000);
});

test('War Room attaches chances to in-progress picks only, from one pull', async () => {
  const pick = (o) => ({ kind: 'pick', state: 'in', final: false, game_key: 'Seattle Seahawks@Las Vegas Raiders', ...o });
  const members = [{ picks: [
    pick({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5' }),
    pick({ bet_type: 'Over', side: 'over', line: 40.5, final: true, state: 'post' }),
    pick({ bet_type: 'Super Lock', prop: { market: 'rec_yds', player: 'X' } }),
    { kind: 'hidden', bet_type: 'Under' },
  ] }, { picks: [pick({ bet_type: 'Under', side: 'under', line: 40.5 })] }];
  const calls = [];
  await attachLiveChances({}, { season: 2026, week: 11 }, members, NOW, async (...args) => { calls.push(args.slice(1)); return { fetched_at: at, games }; });
  assert.deepEqual(calls, [[2026, 11, ['Seattle Seahawks@Las Vegas Raiders']]]);
  assert.equal(members[0].picks[0].live_odds.at, at);
  assert.equal(members[0].picks[1].live_odds, undefined);
  assert.equal(members[0].picks[2].live_odds, undefined);
  assert.equal(members[1].picks[0].live_odds.chance, 0.5);
  // A failed pull leaves the Live tab exactly as it was.
  const quiet = [{ picks: [pick({ bet_type: 'Dog', pick_text: 'Las Vegas Raiders +2.5' })] }];
  await attachLiveChances({}, { season: 2026, week: 11 }, quiet, NOW, async () => { throw new Error('feed-budget-wait'); });
  assert.equal(quiet[0].picks[0].live_odds, undefined);
});
