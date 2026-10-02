import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
mock.module("../functions/_shared/db.js", {
  namedExports: {
    ignoringConcurrentCreate: (p) => p,
    sql:
      () =>
      (strings, ...params) =>
        db
          .query(
            strings.reduce((q, s, i) => q + (i ? `$${i}` : "") + s, ""),
            params,
          )
          .then((r) => r.rows),
  },
});
const { sharedFeed, providerFetch, readSharedFeed } = await import(
  "../functions/_shared/feed-cache.js"
);
const { freshQuote, verifiedGames, verifiedMarkets, quoteChanged } =
  await import("../functions/_shared/quote-freshness.js");
const { retainSchedule } = await import("../functions/api/odds.js");
const env = { DATABASE_URL: "isolated-test-database" };
after(() => db.close());

test("concurrent cold readers execute one loader and share its result", async () => {
  let calls = 0;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      sharedFeed(env, "cold", 30000, async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 150));
        return { games: ["one"], fetched_at: "original" };
      }),
    ),
  );
  assert.equal(calls, 1);
  for (const r of results) assert.deepEqual(r.games, ["one"]);
  assert.equal(
    (
      await sharedFeed(env, "cold", 30000, () => {
        throw Error("cache miss");
      })
    ).fetched_at,
    "original",
  );
});
test("null results are cached, avoiding repeated empty market requests", async () => {
  await sharedFeed(env, "empty", 30000, async () => null);
  assert.equal(
    await sharedFeed(env, "empty", 30000, () => {
      throw Error("called twice");
    }),
    null,
  );
});
test("refresh failure preserves original timestamp, marks delay, and backs off", async () => {
  await sharedFeed(env, "failure", 30000, async () => ({
    fetched_at: "original",
    live: true,
    stale: false,
    games: [],
  }));
  await db.exec(
    "UPDATE feed_refresh SET expires_at='epoch' WHERE cache_key='failure'",
  );
  const stale = await sharedFeed(env, "failure", 30000, async () => {
    throw Error("outage");
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.live, false);
  assert.equal(stale.fetched_at, "original");
  let retries = 0;
  const repeated = await sharedFeed(env, "failure", 30000, () => {
    retries++;
    throw Error("must back off");
  });
  assert.equal(retries, 0);
  assert.equal(repeated.stale, true);
  assert.equal(repeated.live, false);
  assert.equal(repeated.fetched_at, "original");
  assert.equal(verifiedGames(repeated), null);
});
test("expired lease can be reclaimed after an isolate dies", async () => {
  await db.exec(
    "INSERT INTO feed_refresh(cache_key,owner,lease_until) VALUES('abandoned','dead',NOW()-INTERVAL '1 minute')",
  );
  assert.equal(
    (await sharedFeed(env, "abandoned", 30000, async () => ({ ok: true }))).ok,
    true,
  );
});
test("atomic quota reserves board capacity and caps concurrent requests", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}");
  });
  const props = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      providerFetch(env, "sharp", "https://vendor.invalid", {}, 1, "props"),
    ),
  );
  assert.equal(props.filter((r) => r.status === "fulfilled").length, 8);
  await Promise.all([
    providerFetch(env, "sharp", "https://vendor.invalid"),
    providerFetch(env, "sharp", "https://vendor.invalid"),
  ]);
  await assert.rejects(
    providerFetch(env, "sharp", "https://vendor.invalid"),
    /feed-budget-wait/,
  );
  assert.equal(calls, 10);
  await db.exec(
    "UPDATE feed_budget SET requests=ARRAY[EXTRACT(EPOCH FROM NOW())::double precision-61] WHERE provider='sharp'",
  );
  await providerFetch(env, "sharp", "https://vendor.invalid");
  assert.equal(calls, 11);
});
test("429 backoff is shared even when request budget remains", async (t) => {
  await db.exec("UPDATE feed_budget SET requests='{}',blocked_until='epoch'");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "120" } });
  });
  await providerFetch(env, "sharp", "https://vendor.invalid");
  await assert.rejects(
    providerFetch(env, "sharp", "https://vendor.invalid"),
    /feed-budget-wait/,
  );
  assert.equal(calls, 1);
});
test("paid fallback counts credits and honors exhausted monthly quota", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}");
  });
  for (let i = 0; i < 6; i++)
    await providerFetch(env, "oddsapi", "https://vendor.invalid", {}, 2);
  await assert.rejects(
    providerFetch(env, "oddsapi", "https://vendor.invalid"),
    /feed-budget-wait/,
  );
  assert.equal(calls, 6);
  await db.exec(
    "UPDATE feed_budget SET requests='{}' WHERE provider='oddsapi'",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", { headers: { "x-requests-remaining": "0" } }),
  );
  await providerFetch(env, "oddsapi", "https://vendor.invalid");
  await assert.rejects(
    providerFetch(env, "oddsapi", "https://vendor.invalid"),
    /feed-budget-wait/,
  );
});
test("schedule retains an omitted matchup without inventing its odds", () => {
  const event = {
    id: "2",
    date: "2026-09-13T17:00Z",
    competitions: [
      {
        competitors: [
          { homeAway: "home", team: { displayName: "Las Vegas Raiders" } },
          { homeAway: "away", team: { displayName: "Miami Dolphins" } },
        ],
      },
    ],
  };
  const result = retainSchedule(
    {
      games: [
        {
          home: "Seattle Seahawks",
          away: "New England Patriots",
          kickoff: "2026-09-10T00:20Z",
          books: {},
        },
      ],
    },
    [event],
  );
  assert.equal(result.games.length, 2);
  assert.equal(result.games[1].odds_unavailable, true);
  assert.deepEqual(result.games[1].books, {});
});
test("quote age is per market and cannot be freshened by a book or response timestamp", () => {
  const now = Date.parse("2026-09-09T20:00Z"),
    current = "2026-09-09T19:59:30Z",
    old = "2026-09-09T19:50Z";
  assert.equal(freshQuote({ updated: old }, { updated: current }, now), false);
  assert.equal(freshQuote({ updated: current, stale: true }, null, now), false);
  assert.equal(freshQuote({ updated: "2026-09-09T20:01Z" }, null, now), false);
  const games = verifiedGames(
    {
      fetched_at: current,
      games: [
        {
          books: {
            fanduel: {
              updated: current,
              spread: { updated: old },
              total: { updated: current },
            },
          },
        },
      ],
    },
    now,
  );
  assert.equal(games[0].books.fanduel.spread, null);
  assert.ok(games[0].books.fanduel.total);
  const markets = verifiedMarkets(
    {
      markets: [
        {
          players: [
            {
              fanduel: { updated: old },
              draftkings: { updated: current },
              alts: [{ line: 80, fanduel: 110, updated: { fanduel: old } }],
            },
          ],
        },
      ],
    },
    now,
  );
  assert.equal(markets[0].players[0].fanduel, null);
  assert.equal(markets[0].players[0].alts[0].fanduel, null);
});
test("changed price, line, or book requires reconfirmation", () => {
  const quote = { book: "fanduel", line: 44.5, price: -110 };
  assert.equal(quoteChanged(quote, { ...quote }), false);
  for (const change of [{ price: -115 }, { line: 45 }, { book: "draftkings" }])
    assert.equal(quoteChanged(quote, { ...quote, ...change }), true);
});


test('a cold refresh loader receives durable previous data for bounded last-good recovery',async()=>{
 const previous={game_key:'Away@Home',markets:[{market:'anytime_td'}],fetched_at:'2026-10-02T12:00:00Z'};
 await sharedFeed(env,'previous-props',60000,async()=>previous);
 await db.exec("UPDATE feed_refresh SET expires_at='epoch' WHERE cache_key='previous-props'");
 let received;
 const result=await sharedFeed(env,'previous-props',60000,async old=>{received=old;return {...old,stale:true};});
 assert.deepEqual(received,previous);assert.deepEqual(result.markets,previous.markets);assert.equal(result.fetched_at,previous.fetched_at);
});

test('props survive a cold-isolate rate limit without refreshing old prices or retention age',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-06T12:00:00Z')});
 const away='New England Patriots',home='Seattle Seahawks',game_key=`${away}@${home}`,key=`props-v6:2026:1:${game_key}`;
 const previous={game_key,away,home,season:2026,week:1,fetched_at:'2026-09-06T11:59:00Z',markets:[{market:'receptions',kind:'ou',players:[{player:'Cooper Kupp',line:3.5,fanduel:{line:3.5,over:-110,under:-110,updated:'2026-09-06T11:59:00Z'}}]}]};
 await sharedFeed(env,key,60000,async()=>previous);
 const oldCaches=globalThis.caches;
 globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
 t.after(()=>{if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;});
 t.mock.method(globalThis,'fetch',async input=>new URL(input).pathname==='/api/odds'
  ? new Response(JSON.stringify({games:[{away,home,sharp_event_ids:['event']}]}))
  : new Response('',{status:429}));
 const request=async n=>{
  await db.query("UPDATE feed_refresh SET expires_at='epoch' WHERE cache_key=$1",[key]);
  const {onRequestGet}=await import(`../functions/api/props.js?cold=${n}`);
  return (await onRequestGet({env:{...env,SHARPAPI_KEY:'test'},request:new Request(`https://example.test/api/props?game_key=${encodeURIComponent(game_key)}`),waitUntil(){}})).json();
 };
 const first=await request(1);
 assert.equal(first.source,'stale');assert.equal(first.markets[0].players[0].fanduel.stale,true);
 assert.equal(first.markets[0].players[0].fanduel.updated,'2026-09-06T11:59:00Z');
 assert.equal(verifiedMarkets(first)[0].players[0].fanduel,null);
 t.mock.timers.tick(20000);
 const second=await request(2);assert.equal(second.retained_at,first.retained_at);assert.equal(second.markets.length,1);
 t.mock.timers.tick(31*60000);
 const expired=await request(3);assert.deepEqual(expired.markets,[]);
});


test('bounded shared snapshots expire and prop discovery avoids the board HTTP hop',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-06T12:00:00Z')});
 const game_key='Dallas Cowboys@Philadelphia Eagles',key='board-v4:2026:1';
 const board={games:[{away:'Dallas Cowboys',home:'Philadelphia Eagles',sharp_event_ids:['shared-event']}]};
 await sharedFeed(env,key,30000,async()=>board);
 assert.deepEqual(await readSharedFeed(env,key,1800000),board);
 assert.equal(await readSharedFeed(env,'board-v4:2026:2',1800000),null);
 await db.exec("UPDATE feed_refresh SET expires_at=NOW()-INTERVAL '31 minutes' WHERE cache_key='board-v4:2026:1'");
 assert.equal(await readSharedFeed(env,key,1800000),null);
 await db.exec("UPDATE feed_refresh SET expires_at=NOW()-INTERVAL '5 minutes' WHERE cache_key='board-v4:2026:1'");
 const oldCaches=globalThis.caches;globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
 t.after(()=>{if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;});
 await db.exec("UPDATE feed_budget SET requests='{}',blocked_until='epoch' WHERE provider='sharp'");
 let calls=0;
 t.mock.method(globalThis,'fetch',async input=>{
  assert.equal(new URL(input).pathname,'/api/v1/events/shared-event/odds');calls++;
  return new Response(JSON.stringify({data:[]}));
 });
 const {onRequestGet}=await import('../functions/api/props.js?shared-board=1');
 const result=await (await onRequestGet({env:{...env,SHARPAPI_KEY:'test'},request:new Request('https://example.test/api/props?game_key='+encodeURIComponent(game_key)),waitUntil(){}})).json();
 assert.equal(calls,1);assert.equal(result.complete,true);assert.deepEqual(result.sharp_event_ids,['shared-event']);
});
