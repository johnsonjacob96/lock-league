import test from 'node:test';
import assert from 'node:assert/strict';
import { neonConfig } from '@neondatabase/serverless';
import { onRequestGet, onRequestPost, scopedPayload, fetchSharpRaw, normalizeSharp } from '../functions/api/odds.js';
import { espnBoxscore, espnSummary } from '../functions/_shared/espn.js';
import { fetchScoreboard, pushWeekResults } from '../functions/_shared/grader.js';
import { seedWeeks, seedRegularSeason } from '../scripts/seed-regular-season.mjs';

const env = { DATABASE_URL: 'postgresql://test:test@database.invalid/test', CRON_SECRET: 'test-secret' };
const summary = { header: { competitions: [{ status: { type: { completed: true, state: 'post' } } }] }, _seedFinal: true, boxscore: { players: [{ team: { displayName: 'Seattle Seahawks' }, statistics: [] }] }, leaders: [] };
const event = (id = '1', date = '2026-09-10T00:20:00Z', state = 'pre') => ({ id, date,
  status: { type: { state, completed: state === 'post' } },
  competitions: [{ competitors: [
    { homeAway: 'home', team: { displayName: 'Seattle Seahawks' } },
    { homeAway: 'away', team: { displayName: 'New England Patriots' } },
  ] }],
});
const game = date => ({ kickoff: date, home: 'Seattle Seahawks', away: 'New England Patriots', books: {} });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const dbRows = (name, value) => json({ fields: name ? [{ name, dataTypeID: 3802 }] : [], rows: name ? [[JSON.stringify(value)]] : [] });
function mockDb(t, fn = () => dbRows()) {
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url, init) => fn(JSON.parse(init.body));
  t.after(() => { neonConfig.fetchFunction = previous; });
}
function clock(t, iso) {
  const OriginalDate = globalThis.Date;
  const timestamp = OriginalDate.parse(iso);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
}
function seedRequest(body) {
  return new Request('https://lock-league.pages.dev/api/odds?action=seed', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Cron-Secret': env.CRON_SECRET },
    body: JSON.stringify(body),
  });
}

test('seed schedule covers preparation, Wednesday opener, rollover and final settlement', () => {
  assert.deepEqual(seedWeeks(Date.parse('2026-09-06T12:00Z')), [1]);
  assert.deepEqual(seedWeeks(Date.parse('2026-09-10T00:20Z')), [1]);
  assert.deepEqual(seedWeeks(Date.parse('2026-09-15T08:00Z')), [2, 1]);
  assert.deepEqual(seedWeeks(Date.parse('2027-01-12T09:00Z')), [18, 17]);
  assert.deepEqual(seedWeeks(Date.parse('2027-02-01T00:00Z')), []);
});

test('unprivileged debug and mock cannot call providers or change shared cache', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const query of ['debug=props', 'mock=1&fresh=1']) {
    const response = await onRequestGet({ env, request: new Request(`https://lock-league.pages.dev/api/odds?${query}`) });
    assert.equal(response.status, 401);
  }
});

test('administrator mock remains outside shared production cache', async t => {
  const mock = await onRequestGet({ env, request: new Request('https://lock-league.pages.dev/api/odds?mock=1', {
    headers: { 'X-Cron-Secret': env.CRON_SECRET },
  }) });
  assert.equal((await mock.json()).source, 'mock');
  // A subsequent normal read must touch the edge/provider, rather than L1 mock.
  let edgeRead = false;
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => { edgeRead = true; return null; } } };
  t.after(() => { if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches; });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  mockDb(t);
  const normal = await onRequestGet({ env, request: new Request('https://lock-league.pages.dev/api/odds') });
  assert.equal(edgeRead, true);
  assert.equal(normal.status, 502);
  assert.notEqual((await normal.json()).source, 'mock');
});

test('scoreboard-only seed persists historical scores and summaries without changing odds', async t => {
  const queries = [];
  mockDb(t, statement => { queries.push(statement); return dbRows(); });
  const response = await onRequestPost({ env, request: seedRequest({ season: 2026, week: 1, seasontype: 2,
    scoreboardOnly: true, events: [event()], summaries: { '1': summary } }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, games: 1, source: 'espn', oddsSeeded: false,
    scoreboardSeeded: true, summariesSeeded: 1 });
  assert.equal(queries.some(s => s.query.includes('odds_snapshot')), false);
  assert.ok(queries.some(s => s.query.includes('INSERT INTO scoreboard_snapshot')));
  assert.ok(queries.some(s => s.query.includes('INSERT INTO game_summary_snapshot')));
});

test('seed persistence failure returns 503 rather than false success', async t => {
  mockDb(t, () => { throw new Error('database down'); });
  const response = await onRequestPost({ env, request: seedRequest({ season: 2026, week: 1, seasontype: 2,
    scoreboardOnly: true, events: [event()] }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).scoreboardSeeded, false);
});

test('seed rejects invalid season and summary belonging to another event', async t => {
  mockDb(t);
  const invalid = await onRequestPost({ env, request: seedRequest({ season: 2027, week: 1, seasontype: 2, events: [event()] }) });
  assert.equal(invalid.status, 400);
  const mismatch = await onRequestPost({ env, request: seedRequest({ season: 2026, week: 1, seasontype: 2,
    scoreboardOnly: true, events: [event()], summaries: { '2': summary } }) });
  assert.equal(mismatch.status, 400);
});

test('ESPN summary and prop boxscore fall back to persisted runner data', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    return new Response('', { status: 403 });
  });
  mockDb(t, ({ query }) => query.includes('SELECT summary') ? dbRows('summary', summary) : dbRows());
  assert.deepEqual(await espnBoxscore('1', env), summary.boxscore);
  assert.deepEqual(await espnSummary('1', env), summary);
});

test('hanging ESPN attempt aborts and moves to fallback', async t => {
  let calls = 0, signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (calls++ > 0) return new Response('', { status: 403 });
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  mockDb(t, ({ query }) => query.includes('SELECT summary') ? dbRows('summary', summary) : dbRows());
  assert.deepEqual(await espnBoxscore('1', env), summary.boxscore);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 4);
});

test('runner ingests final-game boxscore and verifies persistence acknowledgment', async t => {
  let submitted;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('scoreboard?')) return json({ events: [event('1', undefined, 'post')] });
    if (String(url).includes('summary?')) return json(summary);
    submitted = JSON.parse(init.body);
    return json({ ok: true, scoreboardSeeded: true, summariesSeeded: 1 });
  });
  const result = await seedRegularSeason({ siteUrl: 'https://example.invalid', cronSecret: 'test', now: Date.parse('2026-09-10T06:00Z'), log: () => {} });
  assert.deepEqual(result, [{ week: 1, events: 1, summaries: 1 }]);
  assert.equal(submitted.scoreboardOnly, true);
  assert.equal(submitted.summaries['1']._seedFinal, true);
  assert.deepEqual(submitted.summaries['1'].boxscore, summary.boxscore);
});

test('runner rejects HTTP 200 that did not persist the scoreboard', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('scoreboard?')
    ? json({ events: [event()] }) : json({ ok: true, scoreboardSeeded: false, summariesSeeded: 0 }));
  await assert.rejects(seedRegularSeason({ siteUrl: 'https://example.invalid', cronSecret: 'test', now: Date.parse('2026-09-06T06:00Z'), log: () => {} }), /persistence not acknowledged/);
});

test('runner fails if current week missing even when previous week persisted', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('week=2')) return json({ events: [] });
    if (String(url).includes('scoreboard?')) return json({ events: [event()] });
    return json({ ok: true, scoreboardSeeded: true, summariesSeeded: 0 });
  });
  await assert.rejects(seedRegularSeason({ siteUrl: 'https://example.invalid', cronSecret: 'test', now: Date.parse('2026-09-15T09:00Z'), log: () => {} }), /week 2: scoreboard unavailable/);
});

test('odds cache scopes a mixed board to the active week and rejects old metadata', t => {
  clock(t, '2026-09-15T09:00Z');
  const games = [game('2026-09-10T00:20Z'), game('2026-09-17T00:20Z'), game(null)];
  assert.deepEqual(scopedPayload({ source: 'espn', games }, env)?.games, [games[1]]);
  assert.equal(scopedPayload({ source: 'espn', season: 2026, week: 1, games }, env), null);
  assert.equal(scopedPayload({ source: 'mock', games }, env), null);
});

test('previous-week legacy seed does not overwrite current-week odds snapshot', async t => {
  clock(t, '2026-09-15T09:00Z');
  const queries = [];
  mockDb(t, statement => { queries.push(statement); return dbRows(); });
  const response = await onRequestPost({ env, request: seedRequest({ season: 2026, week: 1, seasontype: 2, events: [event()] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).oddsSeeded, false);
  assert.equal(queries.some(s => s.query.includes('odds_snapshot')), false);
});

test('live summary seed cannot grade props when scoreboard final arrives first', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  mockDb(t, ({ query }) => query.includes('SELECT summary') ? dbRows('summary', { ...summary, _seedFinal: false }) : dbRows());
  assert.equal(await espnBoxscore('1', env), null);
  assert.ok((await espnSummary('1', env)).boxscore);
});

test('public UI refresh uses the shared cache without spending provider quota', async t => {
  clock(t, '2026-09-06T12:00Z');
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => json({ source: 'sharpapi', games: [game('2026-09-10T00:20Z')] }) } };
  t.after(() => { if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('provider must not be called'); });
  const response = await onRequestGet({ env, request: new Request('https://lock-league.pages.dev/api/odds?fresh=1') });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Cache'), 'HIT-EDGE');
});

test('ESPN schedule without odds preserves usable last-good lines during provider outage', async t => {
  clock(t, '2026-09-17T12:00Z');
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  t.after(() => { if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches; });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const last = { source: 'sharpapi', games: [{ ...game('2026-09-20T17:00Z'), books: { fanduel: { total: { point: 44.5 } } } }] };
  const statements = [];
  mockDb(t, statement => {
    statements.push(statement.query);
    if (statement.query.includes('SELECT events')) return dbRows('events', [event('2', '2026-09-20T17:00Z')]);
    if (statement.query.includes('SELECT payload')) return dbRows('payload', last);
    return dbRows();
  });
  const response = await onRequestGet({ env, request: new Request('https://lock-league.pages.dev/api/odds') });
  assert.equal(response.headers.get('X-Cache'), 'STALE');
  assert.equal((await response.json()).games[0].books.fanduel.total.point, 44.5);
  assert.equal(statements.some(query => query.includes('INSERT INTO odds_snapshot')), false);
});

test('expired isolate scores refresh from the latest runner seed during continuous ESPN outage', async t => {
  let now = Date.parse('2026-09-10T01:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const raw = event();
  raw.competitions[0].competitors[0].score = '7';
  raw.competitions[0].competitors[1].score = '0';
  let seed = [raw], seedReads = 0;
  mockDb(t, ({ query }) => {
    if (query.includes('SELECT events')) { seedReads++; return dbRows('events', seed); }
    return dbRows();
  });
  assert.equal((await fetchScoreboard(2026, 1, 2, env))[0].home_score, 7);
  now += 70000;
  seed = structuredClone(seed);
  seed[0].competitions[0].competitors[0].score = '14';
  assert.equal((await fetchScoreboard(2026, 1, 2, env))[0].home_score, 14);
  assert.equal(seedReads, 2);
});

test('pending weekly results never reserve notification delivery', async t => {
  clock(t, '2026-09-15T09:00Z');
  const statements = [];
  const rows = data => {
    const fields = Object.keys(data[0] || {}).map(name => ({ name, dataTypeID: 3802 }));
    return json({ fields, rows: data.map(row => fields.map(field => JSON.stringify(row[field.name]))) });
  };
  mockDb(t, ({ query }) => {
    statements.push(query);
    if (query.includes('FROM members')) return rows([{ id: 1, name: 'Jacob' }]);
    if (query.includes('FROM picks')) return rows([{ member_id: 1, bet_type: 'Super Lock', result: null }]);
    return dbRows();
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not send notifications'); });
  assert.deepEqual(await pushWeekResults(env, 2026, 1), { skipped: 'pending-results' });
  assert.equal(statements.some(query => query.includes('week_notifications')), false);
});

test('runner does not label a lagging live summary final merely because scoreboard finished', async t=>{
 let submitted;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(String(url).includes('scoreboard?'))return json({events:[event('1',undefined,'post')]});
  if(String(url).includes('summary?'))return json({...summary,header:{competitions:[{status:{type:{state:'in',completed:false}}}]}});
  submitted=JSON.parse(init.body);return json({ok:true,scoreboardSeeded:true,summariesSeeded:1});
 });
 await seedRegularSeason({siteUrl:'https://example.invalid',cronSecret:'test',now:Date.parse('2026-09-10T06:00Z'),log:()=>{}});
 assert.equal(submitted.summaries['1']._seedFinal,false);
});

test('game board requests exact full-game markets and preserves both books event IDs',async t=>{
 let url;
 t.mock.method(globalThis,'fetch',async input=>{url=new URL(input);return json({data:[],pagination:{has_more:false}});});
 await fetchSharpRaw({SHARPAPI_KEY:'test'});
 assert.equal(url.searchParams.get('market'),'point_spread,total_points');assert.equal(url.searchParams.get('limit'),'200');
 const row={away_team:'New England Patriots',home_team:'Seattle Seahawks',market_type:'point_spread',selection_type:'home',line:-3.5,odds_american:-110,event_start_time:'2026-09-10T00:20Z'};
 const games=normalizeSharp([{...row,event_id:'fd-event',sportsbook:'fanduel'},{...row,event_id:'dk-event',sportsbook:'draftkings'}]);
 assert.deepEqual(games[0].sharp_event_ids,['fd-event','dk-event']);
});
