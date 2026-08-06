// /api/odds — proxy NFL spreads + totals from The Odds API.
//
// Delivery is layered so a burst of users (or an upstream hiccup) never turns
// into a burst of upstream calls or a blank board:
//   L1  warm-isolate memory            (this file, ~5 min)
//   L2  colo-shared Cache API          (caches.default, honors max-age)
//   L3  last-good snapshot in Neon     (served stale when upstream fails)
// Upstream is only ever hit on a full miss, so 10 users at a colo collapse to
// one credit spend per window instead of ten.
import { json } from "../_shared/auth.js";
import { sql } from "../_shared/db.js";
import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS } from "../_shared/nfl.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const EDGE_TTL_S = 300; // colo-shared cache freshness, matches CACHE_TTL_MS
let cache = { ts: 0, data: null };
const API_BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
// Synthetic, cookie-free key for the shared Cache API entry.
const EDGE_KEY = new Request("https://lock-league.internal/cache/odds");

// Kickoff window for the week being picked: the current week in season,
// week 1 before kickoff, the final week once the season ends.
function oddsWindow() {
  const cur = currentNflWeek();
  const week = cur.status === "postseason" ? REGULAR_SEASON_WEEKS : (cur.week || 1);
  return weekWindow(week);
}

function normalize(events) {
  return events.map((ev) => {
    const out = { id: ev.id, kickoff: ev.commence_time, home: ev.home_team, away: ev.away_team, books: {} };
    for (const bk of ev.bookmakers || []) {
      const key = bk.key;
      if (!["fanduel", "draftkings"].includes(key)) continue;
      const bookOut = { spread: null, total: null, updated: bk.last_update };
      for (const m of bk.markets || []) {
        if (m.key === "spreads") {
          const home = m.outcomes.find((o) => o.name === ev.home_team);
          const away = m.outcomes.find((o) => o.name === ev.away_team);
          if (home && away) {
            const favTeam = home.point < 0 ? ev.home_team : ev.away_team;
            const line = Math.min(home.point, away.point);
            const favPrice = home.point < 0 ? home.price : away.price;
            const dogPrice = home.point < 0 ? away.price : home.price;
            bookOut.spread = { fav: favTeam, line, favPrice, dogPrice };
          }
        }
        if (m.key === "totals") {
          const over = m.outcomes.find((o) => o.name === "Over");
          const under = m.outcomes.find((o) => o.name === "Under");
          if (over && under) {
            bookOut.total = { point: over.point, overPrice: over.price, underPrice: under.price };
          }
        }
      }
      out.books[key] = bookOut;
    }
    return out;
  });
}

function mockData() {
  const games = [
    ["Dallas Cowboys", "Philadelphia Eagles", -3.5, 47.5],
    ["Kansas City Chiefs", "Buffalo Bills", -2.5, 48.5],
    ["Baltimore Ravens", "Cincinnati Bengals", -4.5, 50.5],
    ["San Francisco 49ers", "Los Angeles Rams", -6.0, 45.5],
    ["Detroit Lions", "Chicago Bears", -7.5, 47.0],
    ["Green Bay Packers", "Minnesota Vikings", -3.0, 44.5],
    ["Miami Dolphins", "New York Jets", -5.5, 41.5],
    ["Houston Texans", "Indianapolis Colts", -2.0, 45.0],
  ];
  const now = Date.now();
  return games.map(([away, home, fav, total], i) => ({
    id: `mock-${i}`,
    kickoff: new Date(now + (i + 1) * 3600 * 1000).toISOString(),
    home, away,
    books: {
      fanduel: { spread: { fav: home, line: fav, favPrice: -110, dogPrice: -110 }, total: { point: total, overPrice: -110, underPrice: -110 }, updated: new Date(now).toISOString() },
      draftkings: { spread: { fav: home, line: fav - 0.5, favPrice: -108, dogPrice: -112 }, total: { point: total + 0.5, overPrice: -110, underPrice: -110 }, updated: new Date(now).toISOString() },
    },
  }));
}

// ── L3: last-good snapshot in Neon ──────────────────────────────────────────
// Self-healing: the table is created on first write, and every read/write is
// best-effort so a missing table or a DB blip never breaks the live endpoint.
let snapshotReady = false;
async function saveSnapshot(env, payload) {
  try {
    const s = sql(env);
    if (!snapshotReady) {
      await s`CREATE TABLE IF NOT EXISTS odds_snapshot (
        id INT PRIMARY KEY,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      snapshotReady = true;
    }
    await s`INSERT INTO odds_snapshot (id, payload, fetched_at)
            VALUES (1, ${JSON.stringify(payload)}::jsonb, NOW())
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`;
  } catch { /* snapshot is best-effort */ }
}
async function loadSnapshot(env) {
  try {
    const rows = await sql(env)`SELECT payload, fetched_at FROM odds_snapshot WHERE id = 1`;
    if (rows.length) return { ...rows[0].payload, stale: true, snapshot_at: rows[0].fetched_at };
  } catch { /* no snapshot yet */ }
  return null;
}

const hdr = (state, extra = {}) => ({ headers: { "X-Cache": state, "Cache-Control": "public, max-age=60", ...extra } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : () => {};
  const url = new URL(request.url);
  const key = env.ODDS_API_KEY;
  const liveEnabled = env.ODDS_LIVE === "1";
  const useMock = !key || !liveEnabled || url.searchParams.get("mock") === "1";
  const force = url.searchParams.get("fresh") === "1";

  // L1 — warm isolate memory.
  if (!force && cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return json(cache.data, hdr("HIT-MEM"));
  }

  if (useMock) {
    const payload = { source: "mock", fetched_at: new Date().toISOString(), games: mockData() };
    cache = { ts: Date.now(), data: payload };
    return json(payload, hdr("MISS-MOCK"));
  }

  // L2 — colo-shared Cache API (returns a miss once past EDGE_TTL_S).
  const edge = caches.default;
  if (!force) {
    try {
      const cached = await edge.match(EDGE_KEY);
      if (cached) {
        const payload = await cached.json();
        cache = { ts: Date.now(), data: payload };
        return json(payload, hdr("HIT-EDGE"));
      }
    } catch { /* fall through to upstream */ }
  }

  // Full miss — spend one upstream credit.
  const apiUrl = new URL(API_BASE);
  apiUrl.searchParams.set("apiKey", key);
  apiUrl.searchParams.set("regions", "us");
  apiUrl.searchParams.set("markets", "spreads,totals");
  apiUrl.searchParams.set("oddsFormat", "american");
  apiUrl.searchParams.set("bookmakers", "fanduel,draftkings");
  apiUrl.searchParams.set("dateFormat", "iso");
  const win = oddsWindow();
  apiUrl.searchParams.set("commenceTimeFrom", win.from);
  apiUrl.searchParams.set("commenceTimeTo", win.to);

  try {
    const r = await fetch(apiUrl);
    if (!r.ok) return await serveStaleOr(env, waitUntil, { error: "odds-api", status: r.status, body: await r.text() }, 502);
    const events = await r.json();
    const payload = {
      source: "the-odds-api",
      fetched_at: new Date().toISOString(),
      remaining: r.headers.get("x-requests-remaining"),
      used: r.headers.get("x-requests-used"),
      games: normalize(events),
    };
    cache = { ts: Date.now(), data: payload };
    // Populate the shared cache + last-good snapshot without blocking the response.
    waitUntil(edge.put(EDGE_KEY, new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${EDGE_TTL_S}` },
    })));
    waitUntil(saveSnapshot(env, payload));
    return json(payload, hdr("MISS", { "X-Odds-Remaining": payload.remaining || "" }));
  } catch (e) {
    return await serveStaleOr(env, waitUntil, { error: "fetch-failed", message: e.message }, 500);
  }
}

// Upstream failed: serve the last-good snapshot (marked stale) if we have one,
// otherwise surface the error. Either way the board stays useful.
async function serveStaleOr(env, waitUntil, errBody, status) {
  const snap = await loadSnapshot(env);
  if (snap) {
    cache = { ts: Date.now(), data: snap };
    return json(snap, hdr("STALE"));
  }
  return json({ source: "error", ...errBody }, { status });
}
