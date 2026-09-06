import test from 'node:test';
import assert from 'node:assert/strict';

const AWAY = 'New England Patriots', HOME = 'Seattle Seahawks';
const KEY = `${AWAY}@${HOME}`;
const env = { SHARPAPI_KEY: 'test', CRON_SECRET: 'test-secret' };
let moduleIndex = 0;
async function setup(t) {
  const { onRequestGet, mergePartialProps } = await import(`../functions/api/props.js?test=${++moduleIndex}`);
  let now = Date.parse('2026-09-06T12:00Z');
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
  const stored = new Map(), writes = [];
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: {
    match: async key => stored.get(key.url)?.clone() || null,
    put: async (key, response) => { writes.push(key.url); stored.set(key.url, response.clone()); },
  } };
  t.after(() => { if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches; });
  const waiting = [];
  const request = (key = KEY, customEnv = env, query = '') => onRequestGet({ env: customEnv,
    request: new Request(`https://lock-league.pages.dev/api/props?game_key=${encodeURIComponent(key)}${query}`),
    waitUntil(promise) { waiting.push(promise); },
  });
  return { request, writes, stored, mergePartialProps,
    advance(ms) { now += ms; }, drain: () => Promise.all(waiting) };
}
const json = data => new Response(JSON.stringify(data));
const row = (book = 'fanduel', player = 'Cooper Kupp', side = 'over', price = -110) => ({
  event_id: book === 'fanduel' ? 'fd-123' : 'dk-456', sportsbook: book,
  market_type: 'player_receptions', is_player_prop: true, is_main_line: true,
  player_name: player, selection_type: side, selection: side, line: 3.5, odds_american: price,
  away_team: AWAY, home_team: HOME, event_start_time: '2026-09-10T00:20Z',
});
const board = ids => ({ games: [{ id: 'espn-or-first-id', sharp_event_ids: ids,
  away: AWAY, home: HOME, kickoff: '2026-09-10T00:20Z' }] });

test('per-game request filters all FD/DK IDs, drops unrelated events and reuses cached menu', async t => {
  const h = await setup(t), providerUrls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/api/odds') return json(board(['fd-123', 'dk-456', 'fd-123']));
    providerUrls.push(url);
    assert.ok(init.signal instanceof AbortSignal);
    return json({ data: [row(), row('draftkings'), { ...row('fanduel', 'Wrong Game'), event_id: 'other' }], pagination: { has_more: false } });
  });
  const first = await (await h.request()).json();
  assert.equal(first.complete, true);
  assert.equal(first.markets[0].players.length, 1);
  assert.ok(first.markets[0].players[0].fanduel);
  assert.ok(first.markets[0].players[0].draftkings);
  assert.equal(providerUrls.length, 1);
  assert.equal(providerUrls[0].searchParams.get('event_id'), 'fd-123,dk-456');
  assert.equal(providerUrls[0].searchParams.get('market'), 'props');
  assert.equal(providerUrls[0].searchParams.get('limit'), '200');
  await h.request();
  assert.equal(providerUrls.length, 1);
  await h.drain();
});

test('duplicate cold requests share one board lookup and one provider fetch', async t => {
  const h = await setup(t);
  let boards = 0, props = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname === '/api/odds') { boards++; return json(board(['fd-123'])); }
    props++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return json({ data: [row()], pagination: { has_more: false } });
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => h.request()));
  assert.ok(results.every(response => response.ok));
  assert.equal(boards, 1);
  assert.equal(props, 1);
  await h.drain();
});

test('missing Sharp IDs returns explicit unavailable without a league-wide scan', async t => {
  const h = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    calls++;
    assert.equal(new URL(input).pathname, '/api/odds');
    return json(board(undefined));
  });
  const result = await (await h.request()).json();
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.markets, []);
  assert.equal(calls, 1);
  await h.drain();
});

test('partial pagination preserves missing same-game players and books, without replacing last-good', async t => {
  const h = await setup(t);
  let phase = 0, pages = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname === '/api/odds') return json(board(['fd-123', 'dk-456']));
    if (phase === 0) return json({ data: [row(), row('draftkings'), row('fanduel', 'Stefon Diggs')], pagination: { has_more: false } });
    pages++;
    if (pages === 1) return json({ data: [row('fanduel', 'Cooper Kupp', 'over', 120)], pagination: { has_more: true, next_cursor: 'next-page' } });
    return new Response('', { status: 429 });
  });
  await h.request(); await h.drain();
  const lastWrites = h.writes.filter(key => key.includes('/last/')).length;
  phase = 1; h.advance(6 * 60 * 1000);
  const result = await (await h.request()).json();
  assert.equal(result.complete, false);
  assert.equal(result.stale, true);
  assert.equal(result.markets[0].players.length, 2);
  const kupp = result.markets[0].players.find(player => player.player === 'Cooper Kupp');
  assert.equal(kupp.fanduel.over, 120);
  assert.ok(kupp.draftkings);
  await h.drain();
  assert.equal(h.writes.filter(key => key.includes('/last/')).length, lastWrites);
});

test('pagination cap is explicit and does not exhaust the league request budget', async t => {
  const h = await setup(t);
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).pathname === '/api/odds') return json(board(['fd-123']));
    pages++;
    return json({ data: [row()], pagination: { has_more: true, next_cursor: `cursor-${pages}` } });
  });
  const result = await (await h.request()).json();
  assert.equal(pages, 4);
  assert.equal(result.complete, false);
  assert.equal(result.stale, true);
  await h.drain();
});

test('last-good prices from a different main line are never spliced into the new book line', async t => {
  const { mergePartialProps } = await setup(t);
  const old = { market: 'receptions', player: 'Player', line: 3.5, fanduel: { line: 3.5, over: -110, under: -110 }, alts: [] };
  const fresh = { ...old, line: 4.5, fanduel: { line: 4.5, over: 120, under: null } };
  assert.equal(mergePartialProps([old], [fresh])[0].fanduel.under, null);
});

test('public props debug remains authenticated and does not spend provider quota', async t => {
  const h = await setup(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  assert.equal((await h.request(KEY, env, '&debug=1')).status, 401);
});

test('cached menu from one game is never returned for another matchup', async t => {
  const h = await setup(t);
  t.mock.method(globalThis, 'fetch', async input => new URL(input).pathname === '/api/odds'
    ? json(board(['fd-123'])) : json({ data: [row()], pagination: { has_more: false } }));
  assert.ok((await (await h.request()).json()).markets.length);
  const other = await (await h.request('San Francisco 49ers@Los Angeles Rams')).json();
  assert.deepEqual(other.markets, []);
  assert.equal(other.source, 'unavailable');
  await h.drain();
});

test('hanging board lookup aborts without starting a provider scan', async t => {
  const h = await setup(t);
  let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    calls++; signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const result = await (await h.request()).json();
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(result.source, 'unavailable');
  await h.drain();
});

test('concurrent menus also deduplicate the paid anytime-TD request', async t => {
  const h = await setup(t), vendorCalls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname === '/api/odds') return json(board(['fd-123']));
    if (url.hostname === 'api.sharpapi.io') return json({ data: [row()], pagination: { has_more: false } });
    vendorCalls.push(url.pathname);
    if (url.pathname.endsWith('/events')) return json([{ id: 'odds-api-1', home_team: HOME, away_team: AWAY }]);
    return json({ bookmakers: [{ key: 'fanduel', markets: [{ key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Cooper Kupp', price: 200 }] }] }] });
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => h.request(KEY, { ...env, ODDS_API_KEY: 'test' })));
  for (const result of results) assert.equal((await result.json()).markets[0].market, 'anytime_td');
  assert.equal(vendorCalls.filter(path => path.endsWith('/odds')).length, 1);
  await h.drain();
});
