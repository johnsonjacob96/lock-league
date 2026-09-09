// Provider adapters: request/normalization semantics are independent of cache policy.
import {
  currentNflWeek,
  weekWindow,
  REGULAR_SEASON_WEEKS,
  seasonTypeFor,
  testConfig,
} from "./nfl.js";
import { espnScoreboardEvents } from "./espn.js";
import { loadScoreboardSeed } from "./scoreseed.js";
const API_BASE =
  "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
function currentSeasonWeek(env) {
  const cur = currentNflWeek(new Date(), env);
  const week =
    cur.status === "postseason" ? REGULAR_SEASON_WEEKS : cur.week || 1;
  return { season: cur.season || 2026, week };
}

function normalizeOddsApi(events) {
  return events.map((ev) => {
    const out = {
      id: ev.id,
      kickoff: ev.commence_time,
      home: ev.home_team,
      away: ev.away_team,
      books: {},
    };
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
            bookOut.total = {
              point: over.point,
              overPrice: over.price,
              underPrice: under.price,
            };
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

  const r = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
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
    const home = homeC?.team?.displayName,
      away = awayC?.team?.displayName;
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
        if (String(homeC?.team?.abbreviation || "").toUpperCase() === favAbbr)
          favTeam = home;
        else if (
          String(awayC?.team?.abbreviation || "").toUpperCase() === favAbbr
        )
          favTeam = away;
      }
      const homeFav = favTeam === home;
      const spread =
        favTeam && mag != null
          ? {
              fav: favTeam,
              line: -Math.abs(mag),
              favPrice: numOrNull(
                homeFav
                  ? o.homeTeamOdds?.spreadOdds
                  : o.awayTeamOdds?.spreadOdds,
              ),
              dogPrice: numOrNull(
                homeFav
                  ? o.awayTeamOdds?.spreadOdds
                  : o.homeTeamOdds?.spreadOdds,
              ),
            }
          : null;
      const total =
        numOrNull(o.overUnder) != null
          ? {
              point: Number(o.overUnder),
              overPrice: numOrNull(o.overOdds),
              underPrice: numOrNull(o.underOdds),
            }
          : null;
      if (spread || total)
        books.espn = {
          spread,
          total,
          updated: null,
          provider: o.provider?.name || "ESPN",
        };
    }
    // Preseason test insurance: ESPN rarely carries a preseason line, so seed a
    // nominal FD line (home a small favorite) to keep the board pickable if the
    // real FD/DK feed had no coverage. Marked so it's obviously a test line.
    if (testConfig(env) && !Object.keys(books).length) {
      books.fanduel = {
        spread: { fav: home, line: -2.5, favPrice: -110, dogPrice: -110 },
        total: { point: 38.5, overPrice: -110, underPrice: -110 },
        updated: null,
        provider: "Preseason test line",
      };
    }
    games.push({ id: ev.id, kickoff: ev.date, home, away, books });
  }
  return games;
}

async function fetchEspn(env) {
  const { season, week } = currentSeasonWeek(env);
  let events,
    seeded = false;
  try {
    events = await espnScoreboardEvents(season, seasonTypeFor(env), week);
  } catch (error) {
    events = await loadScoreboardSeed(env, season, week, seasonTypeFor(env));
    if (!events?.length) throw error;
    seeded = true;
  }
  const games = normalizeEspnEvents(events, env);
  if (!games.length) throw new Error("espn: no games");
  return {
    source: "espn",
    live: !seeded,
    stale: seeded,
    season,
    week,
    fetched_at: new Date().toISOString(),
    games,
  };
}

// ── Source: SharpAPI (free tier = FanDuel + DraftKings, 60s pregame) ─────────
// SharpAPI returns a flat, one-row-per-selection schema; the exact field that
// holds the spread/total number is not documented (it appears inside the
// `selection` string, e.g. "Over 44.5"), so parsing is deliberately defensive
// and team names are canonicalized to match the ESPN / Odds-API convention.
// Hit /api/odds?debug=sharp (with SHARPAPI_KEY set) to inspect a raw sample.
const NFL_TEAMS = [
  ["ARI", "Arizona Cardinals"],
  ["ATL", "Atlanta Falcons"],
  ["BAL", "Baltimore Ravens"],
  ["BUF", "Buffalo Bills"],
  ["CAR", "Carolina Panthers"],
  ["CHI", "Chicago Bears"],
  ["CIN", "Cincinnati Bengals"],
  ["CLE", "Cleveland Browns"],
  ["DAL", "Dallas Cowboys"],
  ["DEN", "Denver Broncos"],
  ["DET", "Detroit Lions"],
  ["GB", "Green Bay Packers"],
  ["HOU", "Houston Texans"],
  ["IND", "Indianapolis Colts"],
  ["JAX", "Jacksonville Jaguars"],
  ["KC", "Kansas City Chiefs"],
  ["LV", "Las Vegas Raiders"],
  ["LAC", "Los Angeles Chargers"],
  ["LAR", "Los Angeles Rams"],
  ["MIA", "Miami Dolphins"],
  ["MIN", "Minnesota Vikings"],
  ["NE", "New England Patriots"],
  ["NO", "New Orleans Saints"],
  ["NYG", "New York Giants"],
  ["NYJ", "New York Jets"],
  ["PHI", "Philadelphia Eagles"],
  ["PIT", "Pittsburgh Steelers"],
  ["SF", "San Francisco 49ers"],
  ["SEA", "Seattle Seahawks"],
  ["TB", "Tampa Bay Buccaneers"],
  ["TEN", "Tennessee Titans"],
  ["WAS", "Washington Commanders"],
];
const _normName = (s) =>
  String(s || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
function canonicalNflTeam(input) {
  const n = _normName(input);
  if (!n) return null;
  // Exact match first (abbr / full / nickname) so short abbreviations can't be
  // swallowed by a loose substring hit (e.g. "PHI" ⊂ "miamidolphins").
  for (const [abbr, full] of NFL_TEAMS) {
    if (
      n === _normName(abbr) ||
      n === _normName(full) ||
      n === _normName(full.split(" ").pop())
    )
      return full;
  }
  // Loose containment only for longer strings, to avoid 2-3 char collisions.
  if (n.length >= 5) {
    for (const [, full] of NFL_TEAMS) {
      const fn = _normName(full),
        nick = _normName(full.split(" ").pop());
      if (fn.includes(n) || n.includes(fn) || n.includes(nick)) return full;
    }
  }
  return String(input); // unknown -> pass through unchanged
}
// Extract the line/point from whatever field or string carries it.
function sharpPoint(row) {
  for (const k of [
    "point",
    "line",
    "handicap",
    "value",
    "spread",
    "total",
    "number",
    "points",
  ]) {
    if (row[k] != null && Number.isFinite(Number(row[k])))
      return Number(row[k]);
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
const _juiceDist = (...prices) =>
  prices.reduce((s, p) => s + (p == null ? 200 : Math.abs(p + 110)), 0);
function resolveSpread(rows, g) {
  if (!rows.length) return null;
  const byMag = new Map();
  for (const r of rows) {
    const mag = Math.abs(r.point);
    const e =
      byMag.get(mag) ||
      byMag.set(mag, { mag, fav: null, dog: null, main: false }).get(mag);
    if (r.point < 0) e.fav = r;
    else if (r.point > 0) e.dog = r;
    else {
      e.fav = e.fav || r;
      e.dog = e.dog || r;
    }
    if (r.isMain) e.main = true;
  }
  const cands = [...byMag.values()];
  const pool = cands.some((c) => c.main) ? cands.filter((c) => c.main) : cands;
  pool.sort(
    (a, c) =>
      _juiceDist(a.fav?.price, a.dog?.price) -
      _juiceDist(c.fav?.price, c.dog?.price),
  );
  const pick = pool[0];
  let favTeam =
    pick.fav?.team ||
    (pick.dog?.team ? (pick.dog.team === g.home ? g.away : g.home) : null);
  if (!favTeam) return null;
  return {
    fav: favTeam,
    line: -Math.abs(pick.mag),
    favPrice: pick.fav?.price ?? null,
    dogPrice: pick.dog?.price ?? null,
  };
}
function resolveTotal(rows) {
  if (!rows.length) return null;
  const byPoint = new Map();
  for (const r of rows) {
    const e =
      byPoint.get(r.point) ||
      byPoint
        .set(r.point, { point: r.point, over: null, under: null, main: false })
        .get(r.point);
    if (r.ou === "over") e.over = r;
    else if (r.ou === "under") e.under = r;
    if (r.isMain) e.main = true;
  }
  const cands = [...byPoint.values()];
  const pool = cands.some((c) => c.main) ? cands.filter((c) => c.main) : cands;
  pool.sort(
    (a, c) =>
      _juiceDist(a.over?.price, a.under?.price) -
      _juiceDist(c.over?.price, c.under?.price),
  );
  const pick = pool[0];
  return {
    point: pick.point,
    overPrice: pick.over?.price ?? null,
    underPrice: pick.under?.price ?? null,
  };
}

// Recover only uniquely corroborated, two-sided quotes when a book's main
// market was entirely mislabeled as alternate. Never relax invalid/stale flags
// or replace a main quote; each book retains its own number and prices.
function recoverFlaggedMarkets(g, books) {
  const balanced = (p) =>
    Number.isInteger(p) && ((p >= -150 && p <= -100) || (p >= 100 && p <= 130));
  const candidates = (book, type) => {
    const groups = new Map();
    for (const row of book[`_alternate_${type}`] || []) {
      if (!row.marketId || !balanced(row.price)) continue;
      const key = `${row.marketId}:${Math.abs(row.point)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.values()].flatMap((rows) => {
      if (rows.length !== 2) return [];
      if (type === "spread") {
        const [a, b] = rows;
        if (
          a.point !== -b.point ||
          a.point === 0 ||
          a.team === b.team ||
          ![g.home, g.away].includes(a.team) ||
          ![g.home, g.away].includes(b.team)
        )
          return [];
        return [resolveSpread(rows, g)];
      }
      if (
        !rows.some((r) => r.ou === "over") ||
        !rows.some((r) => r.ou === "under")
      )
        return [];
      return [resolveTotal(rows)];
    });
  };
  const agrees = (a, b, type) =>
    a &&
    b &&
    (type === "spread"
      ? a.fav === b.fav && Math.abs(a.line - b.line) <= 1
      : Math.abs(a.point - b.point) <= 3);
  for (const type of ["spread", "total"]) {
    const pending = Object.fromEntries(
      ["fanduel", "draftkings"].map((k) => [
        k,
        g.books[k] ? candidates(g.books[k], type) : [],
      ]),
    );
    const restore = {};
    for (const key of ["fanduel", "draftkings"]) {
      if (books[key]?.[type]) continue;
      const other = key === "fanduel" ? "draftkings" : "fanduel";
      const anchors = books[other]?.[type]
        ? [books[other][type]]
        : pending[other];
      const matches = pending[key].filter((a) =>
        anchors.some((b) => agrees(a, b, type)),
      );
      if (matches.length === 1) restore[key] = matches[0];
    }
    // If both main markets are absent, both books must have a unique match.
    for (const [key, quote] of Object.entries(restore)) {
      const other = key === "fanduel" ? "draftkings" : "fanduel";
      if (!books[other]?.[type] && !restore[other]) continue;
      books[key] ||= {
        spread: null,
        total: null,
        updated: g.books[key].updated || null,
      };
      books[key][type] = quote;
    }
  }
}

export function normalizeSharp(rows) {
  // exported for tests; CF ignores non-handler exports
  // First pass: bucket every spread/total selection (main + alternate) per game+book.
  const games = new Map();
  for (const row of rows || []) {
    if (
      row.is_player_prop === true ||
      row.is_active === false ||
      row.is_stale_pregame_price === true ||
      row.is_impossible_scoreline === true
    )
      continue;
    const mt = String(row.market_type ?? row.market ?? "").toLowerCase();
    // SharpAPI's spread,total feed also carries derivative markets that share the
    // same keywords and would otherwise pollute the board: team totals (~20-24
    // pts, e.g. team_total / 1st_half_team_total), half/quarter lines
    // (1st_half_total_points, 3rd_quarter_point_spread, ...), total_touchdowns
    // (~5.5), and odd/even. Only the FULL-GAME point spread and points total
    // belong on the board, so drop anything scoped to a team, a period, or a
    // non-points derivative before the keyword match.
    const isDerivative =
      /team/.test(mt) || // team_total, *_team_total
      /1st|2nd|3rd|4th|half|quarter|period/.test(mt) || // half/quarter lines
      /touchdown|odd|even/.test(mt); // total_touchdowns, odd/even
    if (isDerivative) continue;
    const isSpread = mt.includes("spread") || mt.includes("handicap");
    const isTotal =
      mt.includes("total") || mt.includes("over") || mt.includes("under");
    if (!isSpread && !isTotal) continue;
    const book = sharpBookKey(row.sportsbook);
    if (!book) continue;
    const home = canonicalNflTeam(row.home_team ?? row.home);
    const away = canonicalNflTeam(row.away_team ?? row.away);
    if (!home || !away) continue;
    const key = `${away}@${home}`;
    let g = games.get(key);
    if (!g) {
      g = {
        id: row.event_id ?? key,
        sharp_event_ids: [],
        kickoff: null,
        home,
        away,
        books: {},
      };
      games.set(key, g);
    }
    if (
      row.event_id != null &&
      !g.sharp_event_ids.includes(String(row.event_id))
    )
      g.sharp_event_ids.push(String(row.event_id));
    if (!g.kickoff)
      g.kickoff =
        row.event_start_time ??
        row.start_time ??
        row.commence_time ??
        row.kickoff ??
        null;
    const b = g.books[book] || (g.books[book] = { _spread: [], _total: [] });
    if (
      Number.isFinite(Date.parse(row.timestamp)) &&
      (!b.updated || Date.parse(row.timestamp) > Date.parse(b.updated))
    )
      b.updated = row.timestamp;
    if (row.espn_supplement) b.supplementedAt = row.timestamp;
    const pt = sharpPoint(row);
    if (pt == null) continue;
    const price = Number.isFinite(Number(row.odds_american))
      ? Number(row.odds_american)
      : null;
    const isMain = row.is_main_line === true;
    const stype = String(row.selection_type ?? "").toLowerCase();
    const sel = String(row.selection ?? "").toLowerCase();
    if (isTotal) {
      const ou =
        stype === "over" || (!stype && sel.includes("over")) ? "over" : "under";
      if (row.is_alternate_line === true) {
        (b._alternate_total ||= []).push({
          point: pt,
          ou,
          price,
          isMain,
          marketId: row.market_id,
        });
      } else b._total.push({ point: pt, ou, price, isMain });
    } else {
      const side = String(row.team_side ?? stype).toLowerCase();
      const team =
        side === "home"
          ? home
          : side === "away"
            ? away
            : canonicalNflTeam(
                String(row.selection ?? "")
                  .replace(/\s*[-+]?\d+(?:\.\d+)?\s*$/, "")
                  .trim(),
              );
      if (row.is_alternate_line === true) {
        (b._alternate_spread ||= []).push({
          point: pt,
          team,
          price,
          isMain,
          marketId: row.market_id,
        });
      } else b._spread.push({ point: pt, team, price, isMain });
    }
  }
  // Second pass: resolve each book's main spread + total, drop empties.
  const out = [];
  for (const g of games.values()) {
    const books = {};
    for (const [bk, b] of Object.entries(g.books)) {
      const spread = resolveSpread(b._spread, g);
      const total = resolveTotal(b._total);
      if (spread || total)
        books[bk] = {
          spread,
          total,
          updated: b.supplementedAt || b.updated || null,
          ...(b.supplementedAt
            ? { supplemental: true, provider: "DraftKings via ESPN" }
            : {}),
        };
    }
    recoverFlaggedMarkets(g, books);
    if (Object.keys(books).length) {
      g.books = books;
      out.push(g);
    }
  }
  return out;
}

// SharpAPI is cursor-paginated (~50 rows/page); a full FD+DK spread+total week
// is ~3 pages. Follow pagination.has_more, capped so a runaway can't loop.
export async function fetchSharpRaw(env, maxPages = 8, overrides = null) {
  // exported for tests
  const base = "https://api.sharpapi.io/api/v1/odds";
  const q = {
    league: "nfl",
    sportsbook: "fanduel,draftkings",
    market: "point_spread,total_points",
    limit: "200",
    ...(overrides || {}),
  };
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url, {
      headers: { "X-API-Key": env.SHARPAPI_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      // SharpAPI's free tier caps at ~12 requests/min; a paginated pull can trip
      // that mid-stream (429). Keep whatever we've already paged in rather than
      // discarding the entire fetch — a partial slate beats a blank one. Only
      // surface the error when page 0 itself failed (nothing to salvage), so the
      // caller can fall back or serve stale.
      if (all.length) break;
      throw new Error(
        `sharpapi ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
    }
    const j = await r.json();
    const rows = Array.isArray(j)
      ? j
      : (j.data ?? j.odds ?? j.results ?? j.events ?? []);
    all.push(...rows);
    const pg = j && j.pagination;
    if (!pg || !pg.has_more || !pg.next_cursor) break;
    cursor = pg.next_cursor;
  }
  return all;
}
// Bookmaker event times can differ by a few minutes. Match the current week's
// persisted ESPN schedule so the board countdown agrees with the pick guard.
export function alignSharpKickoffs(games, events) {
  const schedule = new Map(
    (events || []).flatMap((ev) => {
      const cs = ev.competitions?.[0]?.competitors || [];
      const home = canonicalNflTeam(
        cs.find((c) => c.homeAway === "home")?.team?.displayName,
      );
      const away = canonicalNflTeam(
        cs.find((c) => c.homeAway === "away")?.team?.displayName,
      );
      return home && away && Number.isFinite(Date.parse(ev.date))
        ? [[`${away}@${home}`, ev.date]]
        : [];
    }),
  );
  return games.map((g) => {
    const kickoff = schedule.get(`${g.away}@${g.home}`);
    return kickoff &&
      Math.abs(Date.parse(kickoff) - Date.parse(g.kickoff)) <= 3600000
      ? { ...g, kickoff }
      : g;
  });
}

// ESPN's current scoreboard names its sportsbook and carries exact current
// prices under pointSpread/total.*.close. Never relabel consensus or opening odds.
export function espnDraftKingsRows(events, games, updatedAt, now = Date.now()) {
  const age = now - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) return [];
  const out = [];
  const price = (v) =>
    /^[+-]?\d+$/.test(String(v)) && Math.abs(Number(v)) >= 100
      ? Number(v)
      : null;
  const line = (v, prefix = "") => {
    const text = String(v ?? "").replace(new RegExp(`^[${prefix || " "}]`), "");
    return /^[+-]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
  };
  for (const ev of events || []) {
    const comp = ev.competitions?.[0],
      cs = comp?.competitors || [];
    const home = cs.find((c) => c.homeAway === "home")?.team?.displayName;
    const away = cs.find((c) => c.homeAway === "away")?.team?.displayName;
    const g = games.find(
      (g) =>
        g.home === home &&
        g.away === away &&
        Math.abs(Date.parse(g.kickoff) - Date.parse(ev.date)) <= 3600000,
    );
    if (!g) continue;
    const odds = comp.odds?.find(
      (o) =>
        String(o.provider?.id) === "100" && o.provider?.name === "DraftKings",
    );
    if (!odds) continue;
    for (const type of ["spread", "total"]) {
      const existing = g.books?.draftkings?.[type];
      if (
        existing &&
        (type === "spread"
          ? [existing.favPrice, existing.dogPrice]
          : [existing.overPrice, existing.underPrice]
        ).every((p) => Number.isFinite(p) && Math.abs(p) >= 100)
      )
        continue;
      const sides = type === "spread" ? ["home", "away"] : ["over", "under"];
      const market = type === "spread" ? odds.pointSpread : odds.total;
      const quotes = sides.map((side) => ({
        side,
        point: line(market?.[side]?.close?.line, type === "total" ? "ou" : ""),
        price: price(market?.[side]?.close?.odds),
      }));
      if (quotes.some((q) => q.point === null || q.price === null)) continue;
      if (
        type === "spread"
          ? quotes[0].point !== -quotes[1].point || quotes[0].point === 0
          : quotes[0].point !== quotes[1].point || quotes[0].point <= 0
      )
        continue;
      for (const q of quotes)
        out.push({
          home_team: home,
          away_team: away,
          event_id: g.id,
          event_start_time: ev.date,
          sportsbook: "draftkings",
          market_type: type === "spread" ? "point_spread" : "total_points",
          market_id: `espn:${ev.id}:${type}`,
          selection_type: q.side,
          line: q.point,
          odds_american: q.price,
          is_main_line: true,
          is_active: true,
          timestamp: updatedAt,
          espn_supplement: true,
        });
    }
  }
  return out;
}

async function fetchSharpApi(env) {
  const raw = await fetchSharpRaw(env);
  const all = normalizeSharp(raw);
  // SharpAPI returns the whole season; scope to the current pick week's
  // kickoff window, exactly like the The-Odds-API path.
  const win = weekWindow(currentSeasonWeek(env).week, env);
  const from = Date.parse(win.from),
    to = Date.parse(win.to);
  const scoped = all.filter((g) => {
    const t = Date.parse(g.kickoff);
    return Number.isFinite(t) && t >= from && t < to;
  });
  // Normally never blank the board on a window miss; under preseason test mode
  // do NOT fall back to the full season, or regular-season games would leak in.
  let games = scoped;
  try {
    const cur = currentSeasonWeek(env);
    let events = await loadScoreboardSeed(
      env,
      cur.season,
      cur.week,
      seasonTypeFor(env),
    );
    const missing = games.some((g) =>
      ["spread", "total"].some((m) => !g.books?.draftkings?.[m]),
    );
    let updatedAt = events?.source_updated_at;
    if (
      missing &&
      (!updatedAt || Date.now() - Date.parse(updatedAt) > 15 * 60 * 1000)
    ) {
      try {
        events = await espnScoreboardEvents(
          cur.season,
          seasonTypeFor(env),
          cur.week,
        );
        updatedAt = new Date().toISOString();
      } catch {
        /* Old schedule remains usable for times, never for prices. */
      }
    }
    const extra = missing ? espnDraftKingsRows(events, games, updatedAt) : [];
    if (extra.length)
      games = normalizeSharp([...raw, ...extra]).filter((g) => {
        const t = Date.parse(g.kickoff);
        return t >= from && t < to;
      });
    games = alignSharpKickoffs(games, events);
  } catch {
    /* Retain provider times when the schedule snapshot is unavailable. */
  }
  if (!games.length) throw new Error("sharpapi: no games parsed");
  return {
    source: "sharpapi",
    live: true,
    fetched_at: new Date().toISOString(),
    games,
  };
}

export { currentSeasonWeek, fetchOddsApi, fetchEspn, fetchSharpApi };
