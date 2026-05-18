// /api/odds — proxies NFL spreads + totals from The Odds API (FanDuel + DraftKings)
// Caches in-memory per region for 5 minutes (cold start = fresh fetch).
// Returns normalized JSON the frontend can render directly.

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { ts: 0, data: null };

const API_BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";

/**
 * Normalize Odds API response into:
 * [{ id, kickoff, home, away, books: { fanduel: { spread: {fav, line}, total }, draftkings: {...} } }]
 */
function normalize(events) {
  return events.map((ev) => {
    const out = {
      id: ev.id,
      kickoff: ev.commence_time,
      home: ev.home_team,
      away: ev.away_team,
      books: {},
    };
    for (const bk of ev.bookmakers || []) {
      const key = bk.key; // "fanduel" | "draftkings"
      if (!["fanduel", "draftkings"].includes(key)) continue;
      const bookOut = { spread: null, total: null, updated: bk.last_update };
      for (const m of bk.markets || []) {
        if (m.key === "spreads") {
          // Two outcomes: home + away with point values. Negative = favorite.
          const home = m.outcomes.find((o) => o.name === ev.home_team);
          const away = m.outcomes.find((o) => o.name === ev.away_team);
          if (home && away) {
            const favTeam = home.point < 0 ? ev.home_team : ev.away_team;
            const line = Math.min(home.point, away.point); // negative number
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

function mockData() {
  // Light mock so frontend renders during dev w/o API key. Pretends to be Week 1 2026.
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
    kickoff: new Date(now + i * 3600 * 1000).toISOString(),
    home,
    away,
    books: {
      fanduel: {
        spread: { fav: home, line: fav, favPrice: -110, dogPrice: -110 },
        total: { point: total, overPrice: -110, underPrice: -110 },
        updated: new Date(now).toISOString(),
      },
      draftkings: {
        spread: { fav: home, line: fav - 0.5, favPrice: -108, dogPrice: -112 },
        total: { point: total + 0.5, overPrice: -110, underPrice: -110 },
        updated: new Date(now).toISOString(),
      },
    },
  }));
}

export default async function handler(req, res) {
  const key = process.env.ODDS_API_KEY;
  const useMock = !key || req.query.mock === "1";

  // Cache hit
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS && !req.query.fresh) {
    res.setHeader("X-Cache", "HIT");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    return res.status(200).json(cache.data);
  }

  if (useMock) {
    const payload = { source: "mock", fetched_at: new Date().toISOString(), games: mockData() };
    cache = { ts: Date.now(), data: payload };
    res.setHeader("X-Cache", "MISS-MOCK");
    return res.status(200).json(payload);
  }

  const url = new URL(API_BASE);
  url.searchParams.set("apiKey", key);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "spreads,totals");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("bookmakers", "fanduel,draftkings");
  url.searchParams.set("dateFormat", "iso");

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const errBody = await r.text();
      return res.status(502).json({ error: "odds-api", status: r.status, body: errBody });
    }
    const events = await r.json();
    const payload = {
      source: "the-odds-api",
      fetched_at: new Date().toISOString(),
      remaining: r.headers.get("x-requests-remaining"),
      used: r.headers.get("x-requests-used"),
      games: normalize(events),
    };
    cache = { ts: Date.now(), data: payload };
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: "fetch-failed", message: e.message });
  }
}
