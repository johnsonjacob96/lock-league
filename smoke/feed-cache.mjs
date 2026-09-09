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
const { sharedFeed, providerFetch } = await import(
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
    games: [],
  }));
  await db.exec(
    "UPDATE feed_refresh SET expires_at='epoch' WHERE cache_key='failure'",
  );
  const stale = await sharedFeed(env, "failure", 30000, async () => {
    throw Error("outage");
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetched_at, "original");
  assert.equal(
    (
      await sharedFeed(env, "failure", 30000, () => {
        throw Error("must back off");
      })
    ).fetched_at,
    "original",
  );
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
