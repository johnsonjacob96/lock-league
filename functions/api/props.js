// /api/props — player-prop lines for a single game, for the structured Super Lock.
//
// Lazy by design: the picker calls this only when a member opens the prop menu
// for one of their games, so we never pre-pull the whole slate's props. Props
// for the week are fetched once (SharpAPI), normalized to a small menu, cached
// per warm isolate + on the colo-shared Cache API, then filtered to the
// requested game.
//
// Timing note: books don't post weekly stat props until ~1-2 days before each
// game, so this returns an empty menu (live:false-ish) until lines open. That's
// the correct dormant state — the picker shows a "props open closer to kickoff"
// hint and the free-text Super Lock still works.
//
// SharpAPI's exact prop market string isn't documented; SHARP_PROP_MARKET lets
// us pin it once lines go live (a re-probe via /api/odds?debug=props confirms
// the value). Until then we request a sensible default and, if that yields no
// props, fall back to an unfiltered (capped) pull that the keyword-based
// normalizer can still extract props from.
import { json } from "../_shared/auth.js";
import { sameTeam } from "../_shared/grader.js";
import { fetchSharpRaw } from "./odds.js";
import { normalizeSharpProps, PROP_ORDER, PROP_DEFS } from "../_shared/props.js";
import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS } from "../_shared/nfl.js";
import { fetchAnytimeTdMarket } from "../_shared/oddsapi-props.js";

// Props move slowly (books nudge lines, not menus), so cache hard: a 5-min fresh
// window keeps us well under SharpAPI's ~12 req/min cap even with the whole
// league opening prop menus, and the last-good entry survives a transient 429
// for half an hour so one rate-limited pull never blanks the menu for everyone.
const TTL_MS = 5 * 60 * 1000;
const LASTGOOD_TTL_S = 30 * 60;
const EDGE_KEY = new Request("https://lock-league.internal/cache/props");
const EDGE_LASTGOOD = new Request("https://lock-league.internal/cache/props-lastgood");
let cache = { ts: 0, key: "", data: null };

// Anytime-TD-scorer comes from The Odds API (1 credit per game), so cache it hard
// per game: a 15-min fresh window keeps credit use low even as the league opens
// menus, and a 6-hour last-good survives a quota/API hiccup without dropping the
// market. Keys are per week+game.
const ATD_TTL_S = 15 * 60;
const ATD_LASTGOOD_TTL_S = 6 * 3600;
const atdKey = (week, away, home, kind) =>
  new Request(`https://lock-league.internal/cache/atd/${kind}/${week}/${encodeURIComponent(away)}@${encodeURIComponent(home)}`);

// Fetch (or serve cached) the anytime-TD market for one game. Fail-soft: returns
// null on any error so an Odds API hiccup never breaks the SharpAPI prop menu.
async function getAnytimeTd(env, week, away, home, edge, waitUntil) {
  if (!env.ODDS_API_KEY) return null;
  const freshK = atdKey(week, away, home, "fresh");
  const lastK = atdKey(week, away, home, "last");
  try {
    const hit = await edge.match(freshK);
    if (hit) return await hit.json();
  } catch { /* fall through */ }
  let market = null;
  try {
    market = await fetchAnytimeTdMarket(env, away, home);
  } catch (e) {
    console.warn("anytime-td: Odds API failed:", String((e && e.message) || e));
  }
  if (market && market.players && market.players.length) {
    const body = JSON.stringify(market);
    try {
      waitUntil(edge.put(freshK, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ATD_TTL_S}` } })));
      waitUntil(edge.put(lastK, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ATD_LASTGOOD_TTL_S}` } })));
    } catch { /* best-effort */ }
    return market;
  }
  // Empty/failed pull — serve last-good if we have it (quota exhausted, etc.).
  try {
    const lg = await edge.match(lastK);
    if (lg) return await lg.json();
  } catch { /* fall through */ }
  return null;
}

function pickWeek(env) {
  const cur = currentNflWeek(new Date(), env);
  const week = cur.status === "postseason" ? REGULAR_SEASON_WEEKS : (cur.week || 1);
  return { season: cur.season || 2026, week };
}

// Pull the week's props from SharpAPI and normalize. Scoped to the current pick
// week's kickoff window, mirroring the odds path.
async function fetchWeekProps(env) {
  if (!env.SHARPAPI_KEY) return { source: "none", props: [] };
  // SharpAPI groups ALL player props under market=`props` (confirmed live:
  // receptions, passing/rushing/receiving yards, and TD markets all arrive under
  // it; `player_props` returns 0). SHARP_PROP_MARKET can still override without a
  // redeploy — re-probe values via /api/odds?debug=props&market=<v>.
  const primaryMarket = env.SHARP_PROP_MARKET || "props";
  // Cap the paginated pull at 4 pages: the full week's props land in ~3, and
  // every page is one request against a ~12/min budget shared with the odds
  // board. There is deliberately NO unfiltered fallback fetch here — it doubled
  // our request count (and thus 429s) for no gain now that the market string is
  // confirmed. fetchSharpRaw returns a partial slate (not an error) on a
  // mid-pagination 429, so we degrade gracefully instead of blanking.
  let rows;
  try {
    rows = await fetchSharpRaw(env, 4, { market: primaryMarket });
  } catch (e) {
    // Page-0 failure (nothing salvageable), typically a 429. Surface it so the
    // caller serves last-good instead of caching an empty menu.
    console.warn("props: SharpAPI fetch failed:", String((e && e.message) || e));
    return { source: "error", props: [] };
  }
  const props = normalizeSharpProps(rows);
  // Scope to the current pick week by kickoff, when the rows carry a time.
  const win = weekWindow(pickWeek(env).week, env);
  const from = Date.parse(win.from), to = Date.parse(win.to);
  const scoped = props.filter((p) => {
    const t = Date.parse(p.kickoff || "");
    return !Number.isFinite(t) || (t >= from && t < to);
  });
  return { source: "sharpapi", props: scoped };
}

// Shape one game's props into the picker menu: markets in PROP_ORDER, each with
// its players sorted by line then name.
export function menuForGame(props, away, home) { // exported for tests; CF ignores non-handler exports
  const inGame = props.filter((p) =>
    (sameTeam(p.home, home) && sameTeam(p.away, away)) ||
    (sameTeam(p.home, away) && sameTeam(p.away, home)) ||
    // Some feeds only tag one team on a prop row; accept a single-team match too.
    sameTeam(p.home, home) || sameTeam(p.home, away) || sameTeam(p.away, home) || sameTeam(p.away, away));
  const byMarket = new Map();
  for (const p of inGame) {
    const arr = byMarket.get(p.market) || byMarket.set(p.market, []).get(p.market);
    arr.push({ player: p.player, line: p.line, kind: p.kind, fanduel: p.fanduel, draftkings: p.draftkings, alts: p.alts || [] });
  }
  const markets = [];
  for (const key of PROP_ORDER) {
    const players = byMarket.get(key);
    if (!players || !players.length) continue;
    players.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.player.localeCompare(b.player));
    markets.push({ market: key, label: PROP_DEFS[key].label, unit: PROP_DEFS[key].unit, kind: PROP_DEFS[key].kind, players });
  }
  return markets;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : () => {};
  const url = new URL(request.url);
  const gameKey = url.searchParams.get("game_key") || "";
  const [away, home] = gameKey.split("@");

  // Diagnostic: trace every pipeline stage so we can see exactly where props
  // vanish (raw fetch -> normalize -> week-scope -> per-game menu). Read-only,
  // gated behind ?debug=1. Bypasses the cache to reflect a fresh pull.
  if (url.searchParams.get("debug") === "1") {
    if (!env.SHARPAPI_KEY) return json({ error: "no-sharpapi-key" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const out = {};
    try {
      const primaryMarket = env.SHARP_PROP_MARKET || "props";
      out.market = primaryMarket;
      let rawErr = null;
      let rows = await fetchSharpRaw(env, 12, { market: primaryMarket }).catch((e) => { rawErr = String(e && e.message || e); return []; });
      out.rawCount = rows.length;
      out.rawErr = rawErr;
      const mt = {};
      let propRows = 0;
      for (const r of rows) { const k = String(r.market_type || "?"); mt[k] = (mt[k] || 0) + 1; if (r.is_player_prop === true) propRows++; }
      out.rawMarketTypes = mt;
      out.rawPlayerPropRows = propRows;
      let normalized = normalizeSharpProps(rows);
      out.normalizedCount = normalized.length;
      out.normalizedSample = normalized.slice(0, 3).map((p) => ({ market: p.market, player: p.player, line: p.line, home: p.home, away: p.away, kickoff: p.kickoff }));
      // Did the fallback path need to run?
      if (!normalized.length) {
        let fbErr = null;
        const fbRows = await fetchSharpRaw(env, 12, { market: undefined }).catch((e) => { fbErr = String(e && e.message || e); return []; });
        out.fallbackRawCount = fbRows.length;
        out.fallbackErr = fbErr;
        normalized = normalizeSharpProps(fbRows);
        out.fallbackNormalizedCount = normalized.length;
      }
      const win = weekWindow(pickWeek(env).week, env);
      out.window = win;
      const from = Date.parse(win.from), to = Date.parse(win.to);
      const scoped = normalized.filter((p) => { const t = Date.parse(p.kickoff || ""); return !Number.isFinite(t) || (t >= from && t < to); });
      out.scopedCount = scoped.length;
      out.distinctGames = [...new Set(scoped.map((p) => `${p.away}@${p.home}`))].slice(0, 20);
      if (away && home) {
        const markets = menuForGame(scoped, away, home);
        out.gameKey = gameKey;
        out.gameMarkets = markets.map((m) => ({ market: m.market, players: m.players.length }));
      }
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    return json(out, { headers: { "Cache-Control": "no-store" } });
  }

  if (!away || !home) return json({ error: "missing-game_key", markets: [] }, { status: 400 });

  const { week } = pickWeek(env);
  const cacheKey = `props:${week}`;
  const edge = caches.default;

  // Serve the week's normalized props from L1/L2, then filter to this game.
  let weekProps = null, source = "cache", stale = false;
  if (cache.data && cache.key === cacheKey && Date.now() - cache.ts < TTL_MS) {
    weekProps = cache.data;
  } else {
    try {
      const hit = await edge.match(EDGE_KEY);
      if (hit) {
        const payload = await hit.json();
        if (payload.key === cacheKey) { weekProps = payload.props; cache = { ts: Date.now(), key: cacheKey, data: weekProps }; }
      }
    } catch { /* fall through */ }
  }

  // Cache miss or expiry: pull fresh. A non-empty pull becomes the new truth
  // (fresh cache + long-lived last-good). An empty/failed pull (SharpAPI 429 /
  // throttled colo / props not posted yet) must NOT overwrite good data — fall
  // back to the last-good props so one rate-limited fetch never blanks the menu
  // league-wide. Mirrors the odds board's stale-serving behavior.
  if (!weekProps) {
    const res = await fetchWeekProps(env).catch(() => ({ source: "error", props: [] }));
    if (res.props && res.props.length) {
      weekProps = res.props; source = res.source;
      cache = { ts: Date.now(), key: cacheKey, data: weekProps };
      const body = JSON.stringify({ key: cacheKey, props: weekProps, ts: Date.now() });
      try {
        waitUntil(edge.put(EDGE_KEY, new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL_MS / 1000}` },
        })));
        waitUntil(edge.put(EDGE_LASTGOOD, new Response(body, {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${LASTGOOD_TTL_S}` },
        })));
      } catch { /* best-effort */ }
    } else {
      try {
        const lg = await edge.match(EDGE_LASTGOOD);
        if (lg) {
          const payload = await lg.json();
          if (payload.key === cacheKey && payload.props && payload.props.length) {
            weekProps = payload.props; source = "stale"; stale = true;
          }
        }
      } catch { /* fall through */ }
      if (!weekProps) { weekProps = []; source = res.source; }
    }
  }

  const markets = menuForGame(weekProps || [], away, home);
  // Anytime TD (from The Odds API — SharpAPI doesn't carry it). Lazy per game,
  // cached, fail-soft. Prepend so it leads the menu (it's first in PROP_ORDER).
  const atd = await getAnytimeTd(env, week, away, home, edge, waitUntil).catch(() => null);
  if (atd && atd.players.length) markets.unshift(atd);
  return json({
    game_key: gameKey, away, home, week, source, stale,
    live: markets.length > 0,
    markets, fetched_at: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store", "X-Prop-Source": source } });
}
