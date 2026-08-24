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

const TTL_MS = 60 * 1000;
const EDGE_KEY = new Request("https://lock-league.internal/cache/props");
let cache = { ts: 0, key: "", data: null };

function pickWeek(env) {
  const cur = currentNflWeek(new Date(), env);
  const week = cur.status === "postseason" ? REGULAR_SEASON_WEEKS : (cur.week || 1);
  return { season: cur.season || 2026, week };
}

// Pull the week's props from SharpAPI and normalize. Scoped to the current pick
// week's kickoff window, mirroring the odds path.
async function fetchWeekProps(env) {
  if (!env.SHARPAPI_KEY) return { source: "none", props: [] };
  // SharpAPI groups player props under market=`props` (confirmed live: returns
  // player_receptions / player_touchdowns rows; `player_props` returns 0).
  // SHARP_PROP_MARKET can still override without a redeploy.
  const primaryMarket = env.SHARP_PROP_MARKET || "props";
  let rows = await fetchSharpRaw(env, 12, { market: primaryMarket }).catch(() => []);
  let props = normalizeSharpProps(rows);
  if (!props.length) {
    // Wrong/unopened market string: best-effort unfiltered pull (capped), the
    // keyword normalizer still isolates any prop rows present.
    rows = await fetchSharpRaw(env, 12, { market: undefined }).catch(() => []);
    props = normalizeSharpProps(rows);
  }
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
    arr.push({ player: p.player, line: p.line, kind: p.kind, fanduel: p.fanduel, draftkings: p.draftkings });
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
  if (!away || !home) return json({ error: "missing-game_key", markets: [] }, { status: 400 });

  const { week } = pickWeek(env);
  const cacheKey = `props:${week}`;

  // Serve the week's normalized props from L1/L2, then filter to this game.
  let weekProps = null, source = "cache";
  if (cache.data && cache.key === cacheKey && Date.now() - cache.ts < TTL_MS) {
    weekProps = cache.data;
  } else {
    try {
      const edge = caches.default;
      const hit = await edge.match(EDGE_KEY);
      if (hit) {
        const payload = await hit.json();
        if (payload.key === cacheKey) { weekProps = payload.props; cache = { ts: Date.now(), key: cacheKey, data: weekProps }; }
      }
    } catch { /* fall through */ }
  }
  if (!weekProps) {
    const res = await fetchWeekProps(env).catch(() => ({ source: "error", props: [] }));
    weekProps = res.props; source = res.source;
    cache = { ts: Date.now(), key: cacheKey, data: weekProps };
    try {
      const edge = caches.default;
      waitUntil(edge.put(EDGE_KEY, new Response(JSON.stringify({ key: cacheKey, props: weekProps }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL_MS / 1000}` },
      })));
    } catch { /* best-effort */ }
  }

  const markets = menuForGame(weekProps || [], away, home);
  return json({
    game_key: gameKey, away, home, week, source,
    live: markets.length > 0,
    markets, fetched_at: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store", "X-Prop-Source": source } });
}
