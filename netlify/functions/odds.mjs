// /api/odds — proxy NFL spreads + totals from The Odds API.
// Cached in-memory per warm container (5 min).

import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS } from "../../lib/nfl.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { ts: 0, data: null };
const API_BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";

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

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const key = Netlify.env.get("ODDS_API_KEY");
  // Live odds fetching is gated by ODDS_LIVE=1. Default: mock (no credits burned offseason).
  const liveEnabled = Netlify.env.get("ODDS_LIVE") === "1";
  const useMock = !key || !liveEnabled || url.searchParams.get("mock") === "1";

  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS && !url.searchParams.get("fresh")) {
    return json(cache.data, { headers: { "X-Cache": "HIT", "Cache-Control": "public, max-age=60, s-maxage=300" } });
  }

  if (useMock) {
    const payload = { source: "mock", fetched_at: new Date().toISOString(), games: mockData() };
    cache = { ts: Date.now(), data: payload };
    return json(payload, { headers: { "X-Cache": "MISS-MOCK" } });
  }

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
    if (!r.ok) return json({ error: "odds-api", status: r.status, body: await r.text() }, { status: 502 });
    const events = await r.json();
    const payload = {
      source: "the-odds-api",
      fetched_at: new Date().toISOString(),
      remaining: r.headers.get("x-requests-remaining"),
      used: r.headers.get("x-requests-used"),
      games: normalize(events),
    };
    cache = { ts: Date.now(), data: payload };
    return json(payload, { headers: { "X-Cache": "MISS", "Cache-Control": "public, max-age=60, s-maxage=300" } });
  } catch (e) {
    return json({ error: "fetch-failed", message: e.message }, { status: 500 });
  }
};
