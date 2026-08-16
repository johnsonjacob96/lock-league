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
import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS, seasonTypeFor, testConfig } from "../_shared/nfl.js";
import { espnScoreboardEvents } from "../_shared/espn.js";
import { saveScoreboardSeed } from "../_shared/scoreseed.js";

const API_BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
// Synthetic, cookie-free key for the shared Cache API entry.
const EDGE_KEY = new Request("https://lock-league.internal/cache/odds");
let cache = { ts: 0, data: null };

function ttlSeconds(env) {
  const n = Number(env?.ODDS_TTL_S);
  return Number.isFinite(n) && n >= 15 ? n : 60; // floor at 15s to protect quota
}

// The week being picked: current week in season, week 1 before kickoff, the
// final week once the season ends.
function currentSeasonWeek(env) {
  const cur = currentNflWeek(new Date(), env);
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
  const win = weekWindow(currentSeasonWeek(env).week, env);
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

// Normalize raw ESPN scoreboard events → the board's games[] shape. Exported so
// the seed endpoint (fed ESPN events from a GitHub runner, which can reach ESPN
// when the CF colo can't) reuses the exact same parsing.
export function normalizeEspnEvents(events, env) {
  const games = [];
  for (const ev of events || []) {
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
    // Preseason test insurance: ESPN rarely carries a preseason line, so seed a
    // nominal FD line (home a small favorite) to keep the board pickable if the
    // real FD/DK feed had no coverage. Marked so it's obviously a test line.
    if (testConfig(env) && !Object.keys(books).length) {
      books.fanduel = {
        spread: { fav: home, line: -2.5, favPrice: -110, dogPrice: -110 },
        total: { point: 38.5, overPrice: -110, underPrice: -110 },
        updated: null, provider: "Preseason test line",
      };
    }
    games.push({ id: ev.id, kickoff: ev.date, home, away, books });
  }
  return games;
}

async function fetchEspn(env) {
  const { season, week } = currentSeasonWeek(env);
  const events = await espnScoreboardEvents(season, seasonTypeFor(env), week);
  const games = normalizeEspnEvents(events, env);
  if (!games.length) throw new Error("espn: no games");
  return { source: "espn", live: true, fetched_at: new Date().toISOString(), games };
}

// ── Source: SharpAPI (free tier = FanDuel + DraftKings, 60s pregame) ─────────
// SharpAPI returns a flat, one-row-per-selection schema; the exact field that
// holds the spread/total number is not documented (it appears inside the
// `selection` string, e.g. "Over 44.5"), so parsing is deliberately defensive
// and team names are canonicalized to match the ESPN / Odds-API convention.
// Hit /api/odds?debug=sharp (with SHARPAPI_KEY set) to inspect a raw sample.
const NFL_TEAMS = [
  ["ARI", "Arizona Cardinals"], ["ATL", "Atlanta Falcons"], ["BAL", "Baltimore Ravens"],
  ["BUF", "Buffalo Bills"], ["CAR", "Carolina Panthers"], ["CHI", "Chicago Bears"],
  ["CIN", "Cincinnati Bengals"], ["CLE", "Cleveland Browns"], ["DAL", "Dallas Cowboys"],
  ["DEN", "Denver Broncos"], ["DET", "Detroit Lions"], ["GB", "Green Bay Packers"],
  ["HOU", "Houston Texans"], ["IND", "Indianapolis Colts"], ["JAX", "Jacksonville Jaguars"],
  ["KC", "Kansas City Chiefs"], ["LV", "Las Vegas Raiders"], ["LAC", "Los Angeles Chargers"],
  ["LAR", "Los Angeles Rams"], ["MIA", "Miami Dolphins"], ["MIN", "Minnesota Vikings"],
  ["NE", "New England Patriots"], ["NO", "New Orleans Saints"], ["NYG", "New York Giants"],
  ["NYJ", "New York Jets"], ["PHI", "Philadelphia Eagles"], ["PIT", "Pittsburgh Steelers"],
  ["SF", "San Francisco 49ers"], ["SEA", "Seattle Seahawks"], ["TB", "Tampa Bay Buccaneers"],
  ["TEN", "Tennessee Titans"], ["WAS", "Washington Commanders"],
];
const _normName = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
function canonicalNflTeam(input) {
  const n = _normName(input);
  if (!n) return null;
  // Exact match first (abbr / full / nickname) so short abbreviations can't be
  // swallowed by a loose substring hit (e.g. "PHI" ⊂ "miamidolphins").
  for (const [abbr, full] of NFL_TEAMS) {
    if (n === _normName(abbr) || n === _normName(full) || n === _normName(full.split(" ").pop())) return full;
  }
  // Loose containment only for longer strings, to avoid 2-3 char collisions.
  if (n.length >= 5) {
    for (const [, full] of NFL_TEAMS) {
      const fn = _normName(full), nick = _normName(full.split(" ").pop());
      if (fn.includes(n) || n.includes(fn) || n.includes(nick)) return full;
    }
  }
  return String(input); // unknown -> pass through unchanged
}
// Extract the line/point from whatever field or string carries it.
function sharpPoint(row) {
  for (const k of ["point", "line", "handicap", "value", "spread", "total", "number", "points"]) {
    if (row[k] != null && Number.isFinite(Number(row[k]))) return Number(row[k]);
  }
  const m = String(row.selection ?? "").match(/(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return Number(m[1]);
  const mi = String(row.id ?? "").match(/(-?\d+(?:\.\d+)?)\s*$/);
  return mi ? Number(mi[1]) : null;
}
const sharpBookKey = (sb) => {
  const s = String(sb || "").toLowerCase();
  if (s.includes("fanduel") || s === "fd") return "fanduel";
  if (s.includes("draftking") || s === "dk") return "draftkings";
  return null;
};

// SharpAPI mixes the main line with alternate lines (e.g. -3.5 main, -7 alt),
// and its is_main_line flag is only reliably set on one side. So we bucket by
// line magnitude and pick the MAIN line: prefer a magnitude that has any
// main-flagged row, breaking ties by whichever prices sit closest to -110
// (the standard main-line juice; alternates carry skewed prices).
const _juiceDist = (...prices) => prices.reduce((s, p) => s + (p == null ? 200 : Math.abs(p + 110)), 0);
function resolveSpread(rows, g) {
  if (!rows.length) return null;
  const byMag = new Map();
  for (const r of rows) {
    const mag = Math.abs(r.point);
    const e = byMag.get(mag) || byMag.set(mag, { mag, fav: null, dog: null, main: false }).get(mag);
    if (r.point < 0) e.fav = r; else if (r.point > 0) e.dog = r; else { e.fav = e.fav || r; e.dog = e.dog || r; }
    if (r.isMain) e.main = true;
  }
  const cands = [...byMag.values()];
  const pool = cands.some(c => c.main) ? cands.filter(c => c.main) : cands;
  pool.sort((a, c) => _juiceDist(a.fav?.price, a.dog?.price) - _juiceDist(c.fav?.price, c.dog?.price));
  const pick = pool[0];
  let favTeam = pick.fav?.team || (pick.dog?.team ? (pick.dog.team === g.home ? g.away : g.home) : null);
  if (!favTeam) return null;
  return { fav: favTeam, line: -Math.abs(pick.mag), favPrice: pick.fav?.price ?? null, dogPrice: pick.dog?.price ?? null };
}
function resolveTotal(rows) {
  if (!rows.length) return null;
  const byPoint = new Map();
  for (const r of rows) {
    const e = byPoint.get(r.point) || byPoint.set(r.point, { point: r.point, over: null, under: null, main: false }).get(r.point);
    if (r.ou === "over") e.over = r; else if (r.ou === "under") e.under = r;
    if (r.isMain) e.main = true;
  }
  const cands = [...byPoint.values()];
  const pool = cands.some(c => c.main) ? cands.filter(c => c.main) : cands;
  pool.sort((a, c) => _juiceDist(a.over?.price, a.under?.price) - _juiceDist(c.over?.price, c.under?.price));
  const pick = pool[0];
  return { point: pick.point, overPrice: pick.over?.price ?? null, underPrice: pick.under?.price ?? null };
}

export function normalizeSharp(rows) { // exported for tests; CF ignores non-handler exports
  // First pass: bucket every spread/total selection (main + alternate) per game+book.
  const games = new Map();
  for (const row of rows || []) {
    if (row.is_player_prop === true) continue;
    const mt = String(row.market_type ?? row.market ?? "").toLowerCase();
    const isSpread = mt.includes("spread") || mt.includes("handicap");
    const isTotal = mt.includes("total") || mt.includes("over") || mt.includes("under");
    if (!isSpread && !isTotal) continue;
    const book = sharpBookKey(row.sportsbook);
    if (!book) continue;
    const home = canonicalNflTeam(row.home_team ?? row.home);
    const away = canonicalNflTeam(row.away_team ?? row.away);
    if (!home || !away) continue;
    const key = `${away}@${home}`;
    let g = games.get(key);
    if (!g) { g = { id: row.event_id ?? key, kickoff: null, home, away, books: {} }; games.set(key, g); }
    if (!g.kickoff) g.kickoff = row.event_start_time ?? row.start_time ?? row.commence_time ?? row.kickoff ?? null;
    const b = g.books[book] || (g.books[book] = { _spread: [], _total: [] });
    const pt = sharpPoint(row);
    if (pt == null) continue;
    const price = Number.isFinite(Number(row.odds_american)) ? Number(row.odds_american) : null;
    const isMain = row.is_main_line === true;
    const stype = String(row.selection_type ?? "").toLowerCase();
    const sel = String(row.selection ?? "").toLowerCase();
    if (isTotal) {
      const ou = stype === "over" || (!stype && sel.includes("over")) ? "over" : "under";
      b._total.push({ point: pt, ou, price, isMain });
    } else {
      const side = String(row.team_side ?? stype).toLowerCase();
      const team = side === "home" ? home : side === "away" ? away
        : canonicalNflTeam(String(row.selection ?? "").replace(/\s*[-+]?\d+(?:\.\d+)?\s*$/, "").trim());
      b._spread.push({ point: pt, team, price, isMain });
    }
  }
  // Second pass: resolve each book's main spread + total, drop empties.
  const out = [];
  for (const g of games.values()) {
    const books = {};
    for (const [bk, b] of Object.entries(g.books)) {
      const spread = resolveSpread(b._spread, g);
      const total = resolveTotal(b._total);
      if (spread || total) books[bk] = { spread, total, updated: null };
    }
    if (Object.keys(books).length) { g.books = books; out.push(g); }
  }
  return out;
}

// SharpAPI is cursor-paginated (~50 rows/page); a full FD+DK spread+total week
// is ~3 pages. Follow pagination.has_more, capped so a runaway can't loop.
export async function fetchSharpRaw(env, maxPages = 8, overrides = null) { // exported for tests
  const base = "https://api.sharpapi.io/api/v1/odds";
  const q = { league: "nfl", sportsbook: "fanduel,draftkings", market: "spread,total", limit: "500", ...(overrides || {}) };
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url, { headers: { "X-API-Key": env.SHARPAPI_KEY } });
    if (!r.ok) throw new Error(`sharpapi ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.data ?? j.odds ?? j.results ?? j.events ?? []);
    all.push(...rows);
    const pg = j && j.pagination;
    if (!pg || !pg.has_more || !pg.next_cursor) break;
    cursor = pg.next_cursor;
  }
  return all;
}
async function fetchSharpApi(env) {
  const all = normalizeSharp(await fetchSharpRaw(env));
  // SharpAPI returns the whole season; scope to the current pick week's
  // kickoff window, exactly like the The-Odds-API path.
  const win = weekWindow(currentSeasonWeek(env).week, env);
  const from = Date.parse(win.from), to = Date.parse(win.to);
  const scoped = all.filter(g => {
    const t = Date.parse(g.kickoff);
    return Number.isFinite(t) && t >= from && t < to;
  });
  // Normally never blank the board on a window miss; under preseason test mode
  // do NOT fall back to the full season, or regular-season games would leak in.
  const games = scoped.length ? scoped : (testConfig(env) ? [] : all);
  if (!games.length) throw new Error("sharpapi: no games parsed");
  return { source: "sharpapi", live: true, fetched_at: new Date().toISOString(), games };
}

// Which provider drives the primary FD/DK feed. Explicit flag; default keeps
// the existing The-Odds-API behavior so adding a key changes nothing on its own.
function primaryProvider(env) {
  const p = (env.ODDS_PROVIDER || "theoddsapi").toLowerCase();
  if (p === "sharpapi") return env.SHARPAPI_KEY ? "sharpapi" : null;
  return (env.ODDS_API_KEY && env.ODDS_LIVE === "1") ? "theoddsapi" : null;
}
async function fetchPrimary(env, provider) {
  return provider === "sharpapi" ? fetchSharpApi(env) : fetchOddsApi(env);
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
    if (rows.length) {
      const p = rows[0].payload;
      // A deliberately-seeded board (e.g. preseason lines pushed from a GitHub
      // runner because the Worker can't reach ESPN) is served as the real board,
      // not flagged stale. A normal last-good snapshot serves stale.
      if (p && p.seeded) return { ...p, live: true, stale: false, snapshot_at: rows[0].fetched_at };
      return { ...p, live: false, stale: true, snapshot_at: rows[0].fetched_at };
    }
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
  const primary = primaryProvider(env);
  const ttlS = ttlSeconds(env);
  const ttlMs = ttlS * 1000;

  // Debug: why is the board not showing the expected week's games? Dumps the
  // decision inputs + each live source's outcome, so we can see (in the real CF
  // env) whether the ESPN preseason fallback is throwing.
  if (url.searchParams.get("debug") === "why") {
    const out = { now: new Date().toISOString() };
    try { out.testConfig = testConfig(env); } catch (e) { out.testConfig_err = String(e && e.message || e); }
    try { out.currentSeasonWeek = currentSeasonWeek(env); } catch (e) { out.csw_err = String(e && e.message || e); }
    try { out.seasonType = seasonTypeFor(env); } catch (e) { out.st_err = String(e && e.message || e); }
    try { out.weekWindow = weekWindow(currentSeasonWeek(env).week, env); } catch (e) { out.ww_err = String(e && e.message || e); }
    try {
      const p = await fetchSharpApi(env);
      out.sharp = { ok: true, games: (p.games || []).length, first: (p.games || [])[0] };
    } catch (e) { out.sharp = { ok: false, error: String(e && e.message || e) }; }
    try {
      const p = await fetchEspn(env);
      out.espn = { ok: true, source: p.source, games: (p.games || []).length, first: (p.games || [])[0] };
    } catch (e) { out.espn = { ok: false, error: String(e && e.message || e) }; }
    return json(out, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: does SharpAPI actually carry preseason (August) games, and under what
  // market/date? Dumps a date histogram + market_types for both the default
  // (market=spread,total) fetch and an unfiltered fetch, plus how many parsed
  // games land in the current pick-week window.
  if (url.searchParams.get("debug") === "sharpdates") {
    if (!env.SHARPAPI_KEY) return json({ error: "no-sharpapi-key" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const summarize = (rows) => {
      const dateHist = {}, marketByMonth = {};
      let minDate = null, maxDate = null;
      for (const r of rows) {
        const t = r.event_start_time ?? r.start_time ?? r.commence_time ?? r.kickoff;
        const d = String(t || "").slice(0, 10);
        if (!d) continue;
        dateHist[d] = (dateHist[d] || 0) + 1;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
        const mon = d.slice(0, 7), mk = String(r.market_type ?? r.market ?? "?");
        (marketByMonth[mon] || (marketByMonth[mon] = {}))[mk] = (marketByMonth[mon][mk] || 0) + 1;
      }
      return { count: rows.length, minDate, maxDate, marketByMonth, augDates: Object.keys(dateHist).filter(d => d < "2026-09").sort() };
    };
    try {
      const win = weekWindow(currentSeasonWeek(env).week, env);
      const from = Date.parse(win.from), to = Date.parse(win.to);
      // Single unfiltered fetch (stays under SharpAPI's 12 req/min): shows ALL
      // games' dates + market_types, so we can see if August preseason games
      // exist at all and under what market.
      const allm = await fetchSharpRaw(env, 12, { market: undefined });
      const parsed = normalizeSharp(allm);
      const inWin = parsed.filter(g => { const t = Date.parse(g.kickoff); return t >= from && t < to; });
      return json({
        window: win,
        unfiltered: summarize(allm),
        parsedGames: parsed.length,
        parsedInWindow: inWin.length,
        parsedInWindowSample: inWin.slice(0, 6).map(g => ({ away: g.away, home: g.home, kickoff: g.kickoff, books: Object.keys(g.books || {}) })),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  }

  // Debug: inspect a raw SharpAPI sample to finalize the field mapping.
  if (url.searchParams.get("debug") === "sharp") {
    if (!env.SHARPAPI_KEY) return json({ error: "no-sharpapi-key" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    try {
      const raw = await fetchSharpRaw(env);
      return json({ count: raw.length, sample: raw.slice(0, 8), parsedGames: normalizeSharp(raw).slice(0, 2) }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  }

  // Debug: probe SharpAPI's player-prop coverage + row schema so we can build the
  // structured Super Lock. Flexible so we can try market strings without a redeploy:
  //   ?debug=props                 -> ask for market=player_props
  //   ?debug=props&market=<value>  -> override the market param
  //   ?debug=props&nomarket=1      -> omit the market filter entirely (get all)
  if (url.searchParams.get("debug") === "props") {
    if (!env.SHARPAPI_KEY) return json({ error: "no-sharpapi-key" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    try {
      const overrides = url.searchParams.get("nomarket") === "1"
        ? { market: undefined }
        : { market: url.searchParams.get("market") || "player_props" };
      const raw = await fetchSharpRaw(env, 3, overrides);
      // Summarize what came back: distinct market fields + which rows are props.
      const marketVals = {}, typeVals = {};
      let propCount = 0;
      const propSamples = [];
      for (const r of raw) {
        const mk = String(r.market ?? "");
        const mt = String(r.market_type ?? "");
        if (mk) marketVals[mk] = (marketVals[mk] || 0) + 1;
        if (mt) typeVals[mt] = (typeVals[mt] || 0) + 1;
        if (r.is_player_prop === true || /player|prop/i.test(mt) || /player|prop/i.test(mk)) {
          propCount++;
          if (propSamples.length < 10) propSamples.push(r);
        }
      }
      return json({
        requested: overrides, count: raw.length, propCount,
        distinctMarket: marketVals, distinctMarketType: typeVals,
        propSamples, firstRows: raw.slice(0, 3),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
  }

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

  // Source 1 — primary FD/DK feed (The Odds API or SharpAPI, per ODDS_PROVIDER).
  // Snapshotted so it can be served stale later.
  if (primary) {
    try {
      const payload = await fetchPrimary(env, primary);
      // An empty board means "no lines posted yet" or a malformed response,
      // never "no games this week" — always fall through to the ESPN board
      // instead of returning/snapshotting a blank one. (This used to only
      // fall through during the preseason test window, so during the regular
      // season an empty-but-200 primary response was accepted as success and
      // overwrote the last-good snapshot, poisoning the stale fallback too.)
      if (payload.games && payload.games.length) {
        cache = { ts: Date.now(), data: payload };
        waitUntil(putEdge(edge, payload, ttlS));
        waitUntil(saveSnapshot(env, payload));
        return json(payload, hdr("MISS-" + primary.toUpperCase(), payload.remaining ? { "X-Odds-Remaining": payload.remaining } : {}));
      }
    } catch { /* fall through to ESPN */ }
  }

  // Source 2 — ESPN consensus (free). Primary on the no-key path, fallback otherwise.
  // Snapshot ESPN successes too: ESPN is flaky from the Worker, so persisting a
  // good board means one success (from any isolate) sticks for everyone instead
  // of each colo re-rolling against a 403/empty response and serving a stale
  // (possibly wrong-week) snapshot. This is the current-best board regardless of
  // source; a later SharpAPI success overwrites it with FD/DK.
  try {
    const payload = await fetchEspn(env);
    cache = { ts: Date.now(), data: payload };
    waitUntil(putEdge(edge, payload, ttlS));
    waitUntil(saveSnapshot(env, payload));
    return json(payload, hdr(primary ? "MISS-ESPN-FALLBACK" : "MISS-ESPN"));
  } catch { /* fall through */ }

  // Source 3 — last-good snapshot, then mock (no-key path), then error.
  const snap = await loadSnapshot(env);
  if (snap) {
    cache = { ts: Date.now(), data: snap };
    return json(snap, hdr("STALE"));
  }
  if (!primary) {
    const payload = mockPayload();
    return json(payload, hdr("MISS-MOCK"));
  }
  return json({ source: "error", error: "all-sources-failed", live: false, games: [] }, { status: 502, headers: { "Cache-Control": "no-store" } });
}

// POST /api/odds?action=seed  (X-Cron-Secret) — push a board into the snapshot.
// Used to seed preseason lines from a GitHub runner, because the CF Worker can't
// reliably reach ESPN (site.api 403s, cdn returns empty). Body is either
// { events: [...] } (raw ESPN scoreboard events, normalized here) or
// { games: [...] } (already in board shape). Stored with seeded:true so it's
// served as the real board. Nothing overwrites it during preseason test mode
// (SharpAPI throws, live ESPN fails), so one seed persists.
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.searchParams.get("action") !== "seed") {
    return json({ error: "unknown-action" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.CRON_SECRET || request.headers.get("X-Cron-Secret") !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const body = await request.json().catch(() => ({}));
  const games = Array.isArray(body.events) ? normalizeEspnEvents(body.events, env)
    : (Array.isArray(body.games) ? body.games : null);
  if (!games || !games.length) {
    return json({ error: "no-games", detail: "need non-empty events[] or games[]" }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  const payload = { source: body.source || "espn", live: true, seeded: true, fetched_at: new Date().toISOString(), games };
  await saveSnapshot(env, payload);
  cache = { ts: Date.now(), data: payload }; // warm this isolate's L1 immediately
  // Also stash the raw events for the scoreboard (scores/War Room/grading), since
  // the Worker can't reach ESPN. fetchScoreboard falls back to these.
  let scoreboardSeeded = false;
  if (Array.isArray(body.events) && body.season && body.week && body.seasontype) {
    scoreboardSeeded = await saveScoreboardSeed(env, Number(body.season), Number(body.week), Number(body.seasontype), body.events);
  }
  return json({ ok: true, games: games.length, source: payload.source, scoreboardSeeded, first: games[0] }, { headers: { "Cache-Control": "no-store" } });
}
