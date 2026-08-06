// /api/odds — live NFL spreads + totals.
//
// Sources, in order:
//   1. The Odds API  — FanDuel + DraftKings, per-side prices (the real thing)
//   2. ESPN scoreboard — free consensus line, used when The Odds API is down,
//      out of credits, or not enabled yet (so the board is never empty)
//   3. Neon last-good snapshot — served stale only if every live source fails
//
// Delivery is layered so a burst of pickers never becomes a burst of upstream
// calls: L1 warm-isolate memory, L2 colo-shared Cache API, L3 Neon snapshot.
// Freshness (ODDS_TTL_S, default 60s) is tuned for live line movement — the
// client polls on top of this while the board is open.
import { json } from "../_shared/auth.js";
import { sql } from "../_shared/db.js";
import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS } from "../_shared/nfl.js";

const API_BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
// Synthetic, cookie-free key for the shared Cache API entry.
const EDGE_KEY = new Request("https://lock-league.internal/cache/odds");
let cache = { ts: 0, data: null };

function ttlSeconds(env) {
  const n = Number(env?.ODDS_TTL_S);
  return Number.isFinite(n) && n >= 15 ? n : 60; // floor at 15s to protect quota
}

// The week being picked: current week in season, week 1 before kickoff, the
// final week once the season ends.
function currentSeasonWeek() {
  const cur = currentNflWeek();
  const week = cur.status === "postseason" ? REGULAR_SEASON_WEEKS : (cur.week || 1);
  return { season: cur.season || 2026, week };
}

// ── Source 1: The Odds API (FanDuel + DraftKings) ───────────────────────────
function normalizeOddsApi(events) {
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

async function fetchOddsApi(env) {
  const apiUrl = new URL(API_BASE);
  apiUrl.searchParams.set("apiKey", env.ODDS_API_KEY);
  apiUrl.searchParams.set("regions", "us");
  apiUrl.searchParams.set("markets", "spreads,totals");
  apiUrl.searchParams.set("oddsFormat", "american");
  apiUrl.searchParams.set("bookmakers", "fanduel,draftkings");
  apiUrl.searchParams.set("dateFormat", "iso");
  const win = weekWindow(currentSeasonWeek().week);
  apiUrl.searchParams.set("commenceTimeFrom", win.from);
  apiUrl.searchParams.set("commenceTimeTo", win.to);

  const r = await fetch(apiUrl);
  if (!r.ok) throw new Error(`odds-api ${r.status}: ${await r.text()}`);
  const events = await r.json();
  return {
    source: "the-odds-api",
    live: true,
    fetched_at: new Date().toISOString(),
    remaining: r.headers.get("x-requests-remaining"),
    used: r.headers.get("x-requests-used"),
    games: normalizeOddsApi(events),
  };
}

// ── Source 2: ESPN scoreboard (free consensus line) ─────────────────────────
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function fetchEspn(env) {
  const { season, week } = currentSeasonWeek();
  const url = new URL(ESPN_SCOREBOARD);
  url.searchParams.set("year", String(season));
  url.searchParams.set("seasontype", "2");
  url.searchParams.set("week", String(week));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`espn ${r.status}`);
  const data = await r.json();
  const games = [];
  for (const ev of data.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const homeC = competitors.find((c) => c.homeAway === "home");
    const awayC = competitors.find((c) => c.homeAway === "away");
    const home = homeC?.team?.displayName, away = awayC?.team?.displayName;
    if (!home || !away) continue;

    const o = (comp.odds || [])[0];
    const books = {};
    if (o) {
      // Favorite: prefer ESPN's explicit flags, else parse "ABBR -6.5".
      let favTeam = null;
      if (o.homeTeamOdds?.favorite) favTeam = home;
      else if (o.awayTeamOdds?.favorite) favTeam = away;
      let mag = typeof o.spread === "number" ? Math.abs(o.spread) : null;
      const detail = String(o.details || "");
      const dm = detail.match(/(-?\d+(?:\.\d+)?)/);
      if (mag == null && dm) mag = Math.abs(parseFloat(dm[1]));
      if (!favTeam && detail) {
        const favAbbr = detail.split(/\s+/)[0].toUpperCase();
        if (String(homeC?.team?.abbreviation || "").toUpperCase() === favAbbr) favTeam = home;
        else if (String(awayC?.team?.abbreviation || "").toUpperCase() === favAbbr) favTeam = away;
      }
      const homeFav = favTeam === home;
      const spread = (favTeam && mag != null) ? {
        fav: favTeam, line: -Math.abs(mag),
        favPrice: numOrNull(homeFav ? o.homeTeamOdds?.spreadOdds : o.awayTeamOdds?.spreadOdds),
        dogPrice: numOrNull(homeFav ? o.awayTeamOdds?.spreadOdds : o.homeTeamOdds?.spreadOdds),
      } : null;
      const total = numOrNull(o.overUnder) != null
        ? { point: Number(o.overUnder), overPrice: numOrNull(o.overOdds), underPrice: numOrNull(o.underOdds) }
        : null;
      if (spread || total) books.espn = { spread, total, updated: null, provider: o.provider?.name || "ESPN" };
    }
    games.push({ id: ev.id, kickoff: ev.date, home, away, books });
  }
  if (!games.length) throw new Error("espn: no games");
  return { source: "espn", live: true, fetched_at: new Date().toISOString(), games };
}

// ── Source 3: Neon last-good snapshot (FD/DK only) ──────────────────────────
let snapshotReady = false;
async function saveSnapshot(env, payload) {
  try {
    const s = sql(env);
    if (!snapshotReady) {
      await s`CREATE TABLE IF NOT EXISTS odds_snapshot (
        id INT PRIMARY KEY, payload JSONB NOT NULL, fetched_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      snapshotReady = true;
    }
    await s`INSERT INTO odds_snapshot (id, payload, fetched_at)
            VALUES (1, ${JSON.stringify(payload)}::jsonb, NOW())
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`;
  } catch { /* best-effort */ }
}
async function loadSnapshot(env) {
  try {
    const rows = await sql(env)`SELECT payload, fetched_at FROM odds_snapshot WHERE id = 1`;
    if (rows.length) return { ...rows[0].payload, live: false, stale: true, snapshot_at: rows[0].fetched_at };
  } catch { /* none yet */ }
  return null;
}

// ── Mock (dev / screenshots) ────────────────────────────────────────────────
function mockPayload() {
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
  return {
    source: "mock", live: false, fetched_at: new Date().toISOString(),
    games: games.map(([away, home, fav, total], i) => ({
      id: `mock-${i}`, kickoff: new Date(now + (i + 1) * 3600 * 1000).toISOString(), home, away,
      books: {
        fanduel: { spread: { fav: home, line: fav, favPrice: -110, dogPrice: -110 }, total: { point: total, overPrice: -110, underPrice: -110 }, updated: new Date(now).toISOString() },
        draftkings: { spread: { fav: home, line: fav - 0.5, favPrice: -108, dogPrice: -112 }, total: { point: total + 0.5, overPrice: -110, underPrice: -110 }, updated: new Date(now).toISOString() },
      },
    })),
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────
const hdr = (state, extra = {}) => ({ headers: { "X-Cache": state, "Cache-Control": "no-store", ...extra } });
function putEdge(edge, payload, ttlS) {
  return edge.put(EDGE_KEY, new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttlS}` },
  }));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : () => {};
  const url = new URL(request.url);
  const force = url.searchParams.get("fresh") === "1";
  const wantMock = url.searchParams.get("mock") === "1";
  const oddsApiEnabled = !!env.ODDS_API_KEY && env.ODDS_LIVE === "1";
  const ttlS = ttlSeconds(env);
  const ttlMs = ttlS * 1000;

  // L1 — warm-isolate memory.
  if (!force && cache.data && Date.now() - cache.ts < ttlMs) return json(cache.data, hdr("HIT-MEM"));

  if (wantMock) {
    const payload = mockPayload();
    cache = { ts: Date.now(), data: payload };
    return json(payload, hdr("MISS-MOCK"));
  }

  // L2 — colo-shared cache (misses once past ttlS).
  const edge = caches.default;
  if (!force) {
    try {
      const cached = await edge.match(EDGE_KEY);
      if (cached) {
        const payload = await cached.json();
        cache = { ts: Date.now(), data: payload };
        return json(payload, hdr("HIT-EDGE"));
      }
    } catch { /* fall through */ }
  }

  // Source 1 — The Odds API (FD/DK). Snapshotted so it can be served stale later.
  if (oddsApiEnabled) {
    try {
      const payload = await fetchOddsApi(env);
      cache = { ts: Date.now(), data: payload };
      waitUntil(putEdge(edge, payload, ttlS));
      waitUntil(saveSnapshot(env, payload));
      return json(payload, hdr("MISS", { "X-Odds-Remaining": payload.remaining || "" }));
    } catch { /* fall through to ESPN */ }
  }

  // Source 2 — ESPN consensus (free). Primary on the no-key path, fallback otherwise.
  try {
    const payload = await fetchEspn(env);
    cache = { ts: Date.now(), data: payload };
    waitUntil(putEdge(edge, payload, ttlS));
    return json(payload, hdr(oddsApiEnabled ? "MISS-ESPN-FALLBACK" : "MISS-ESPN"));
  } catch { /* fall through */ }

  // Source 3 — last-good snapshot, then mock (no-key path), then error.
  const snap = await loadSnapshot(env);
  if (snap) {
    cache = { ts: Date.now(), data: snap };
    return json(snap, hdr("STALE"));
  }
  if (!oddsApiEnabled) {
    const payload = mockPayload();
    return json(payload, hdr("MISS-MOCK"));
  }
  return json({ source: "error", error: "all-sources-failed", live: false, games: [] }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
