// Lazy, per-game player props: use every SharpAPI event ID represented by the
// current odds board (FD and DK can use different IDs). Never scan the whole
// league merely to open one player's menu.
import { json } from "../_shared/auth.js";
import { sameTeam } from "../_shared/grader.js";
import { normalizeSharpProps, PROP_ORDER, PROP_DEFS } from "../_shared/props.js";
import { currentNflWeek, weekWindow, REGULAR_SEASON_WEEKS } from "../_shared/nfl.js";
import { fetchAnytimeTdMarket } from "../_shared/oddsapi-props.js";

const TTL_MS = 5 * 60 * 1000;
const LASTGOOD_TTL_S = 30 * 60;
const RETRY_MS = 60 * 1000;
const cache = new Map();
const inFlight = new Map();
const atdInFlight = new Map();
const propKey = (key, kind) => new Request(`https://lock-league.internal/cache/props-v2/${kind}/${encodeURIComponent(key)}`);

// Anytime-TD-scorer comes from The Odds API (1 credit per game), so cache it hard
// per game: a 15-min fresh window keeps credit use low even as the league opens
// menus, and a 6-hour last-good survives a quota/API hiccup without dropping the
// market. Keys are per week+game.
const ATD_TTL_S = 15 * 60;
const ATD_LASTGOOD_TTL_S = 6 * 3600;
const atdKey = (period, away, home, kind) =>
  new Request(`https://lock-league.internal/cache/atd/${kind}/${period}/${encodeURIComponent(away)}@${encodeURIComponent(home)}`);

// Fetch (or serve cached) the anytime-TD market for one game. Fail-soft: returns
// null on any error so an Odds API hiccup never breaks the SharpAPI prop menu.
async function fetchCachedAnytimeTd(env, period, away, home, edge, waitUntil) {
  if (!env.ODDS_API_KEY) return null;
  const freshK = atdKey(period, away, home, "fresh");
  const lastK = atdKey(period, away, home, "last");
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

async function getJson(url, init, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: ctrl.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

// One overall budget covers board discovery and all pages. A partial response
// is explicit, so it can retain missing last-good markets without pretending
// the provider removed them. No independent global-week scan is ever needed.
async function fetchGameProps(env, request, away, home, week) {
  const empty = { source: "unavailable", props: [], complete: false, ids: [], pages: 0 };
  if (!env.SHARPAPI_KEY) return empty;
  const deadline = Date.now() + 3500;
  let board;
  try { board = await getJson(new URL("/api/odds", request.url), {}, 1200); }
  catch { return empty; }
  const game = board.games?.find(g => sameTeam(g.away, away) && sameTeam(g.home, home));
  const ids = [...new Set((game?.sharp_event_ids || []).map(String).filter(id => /^[A-Za-z0-9_-]+$/.test(id)))];
  if (!ids.length) return empty; // ESPN event IDs are not SharpAPI IDs
  const raw = [];
  let cursor = null, complete = false, pages = 0;
  for (let page = 0; page < 4; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const url = new URL("https://api.sharpapi.io/api/v1/odds");
    for (const [key, value] of Object.entries({ league: "nfl", sportsbook: "fanduel,draftkings",
      market: env.SHARP_PROP_MARKET || "props", event_id: ids.join(","), limit: "200", ...(cursor ? { cursor } : {}) })) {
      url.searchParams.set(key, value);
    }
    try {
      const data = await getJson(url, { headers: { "X-API-Key": env.SHARPAPI_KEY } }, remaining);
      pages++;
      const rows = Array.isArray(data) ? data : (data.data ?? data.odds ?? data.results ?? []);
      if (!Array.isArray(rows)) break;
      // Reject unrelated rows even if a vendor ignores its filter.
      raw.push(...rows.filter(row => ids.includes(String(row.event_id))));
      if (!data.pagination?.has_more) { complete = true; break; }
      if (!data.pagination.next_cursor || data.pagination.next_cursor === cursor) break;
      cursor = data.pagination.next_cursor;
    } catch { break; }
  }
  const window = weekWindow(week, env), from = Date.parse(window.from), to = Date.parse(window.to);
  const props = normalizeSharpProps(raw).filter(p => {
    const t = Date.parse(p.kickoff);
    return (!Number.isFinite(t) || (t >= from && t < to)) &&
      sameTeam(p.away, away) && sameTeam(p.home, home);
  });
  return { source: props.length ? "sharpapi" : "unavailable", props, complete, ids, pages };
}

// Retain omitted players/books/alternates only through an incomplete provider
// pull. Never splice prices from two different main lines within one book.
export function mergePartialProps(previous, fresh) {
  const key = p => `${p.market}:${p.player.toLowerCase()}`;
  const merged = new Map(previous.map(p => [key(p), p]));
  for (const p of fresh) {
    const old = merged.get(key(p));
    if (!old) { merged.set(key(p), p); continue; }
    const next = { ...old, ...p };
    for (const book of ["fanduel", "draftkings"]) {
      const cur = p[book], prev = old[book];
      if (!cur) next[book] = prev;
      else if (prev && cur.line === prev.line) {
        next[book] = { ...cur, over: cur.over ?? prev.over, under: cur.under ?? prev.under, yes: cur.yes ?? prev.yes };
      }
    }
    const alts = new Map((old.alts || []).map(a => [a.line, a]));
    for (const alt of p.alts || []) {
      const prev = alts.get(alt.line);
      alts.set(alt.line, { ...alt, fanduel: alt.fanduel ?? prev?.fanduel ?? null,
        draftkings: alt.draftkings ?? prev?.draftkings ?? null });
    }
    next.alts = [...alts.values()].filter(a => a.line > next.line).sort((a, b) => a.line - b.line);
    merged.set(key(p), next);
  }
  return [...merged.values()];
}

async function edgeRead(edge, key) {
  try { const hit = await edge.match(key); return hit ? await hit.json() : null; }
  catch { return null; }
}
function persist(edge, key, payload, seconds, waitUntil) {
  const job = edge.put(key, new Response(JSON.stringify(payload), { headers: {
    "Content-Type": "application/json", "Cache-Control": `public, max-age=${seconds}`,
  } })).catch(() => {});
  waitUntil(job);
}
async function bounded(promise, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]); }
  finally { clearTimeout(timer); }
}

async function loadGame(context, key, away, home, season, week) {
  const { request, env } = context;
  const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : () => {};
  const edge = caches.default;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data;
  const stored = await edgeRead(edge, propKey(key, "fresh"));
  if (stored?.key === key && Date.now() < stored.expires) {
    cache.set(key, stored);
    return stored.data;
  }
  const old = await edgeRead(edge, propKey(key, "last"));
  const last = old?.key === key && Date.now() - old.ts < LASTGOOD_TTL_S * 1000 ? old.props : [];
  // Both sources work in parallel. A slow ATD request finishes in waitUntil and
  // populates its own cache; it cannot hold up the SharpAPI menu indefinitely.
  let atdJob = atdInFlight.get(key);
  if (!atdJob) {
    atdJob = fetchCachedAnytimeTd(env, `${season}:${week}`, away, home, edge, waitUntil).catch(() => null)
      .finally(() => atdInFlight.delete(key));
    atdInFlight.set(key, atdJob);
  }
  waitUntil(atdJob);
  const [result, atd] = await Promise.all([
    fetchGameProps(env, request, away, home, week), bounded(atdJob, 3500),
  ]);
  const stale = !result.complete || !result.props.length;
  const props = stale ? mergePartialProps(last || [], result.props) : result.props;
  const markets = menuForGame(props, away, home);
  if (atd?.players?.length) {
    const duplicate = markets.findIndex(m => m.market === "anytime_td");
    if (duplicate >= 0) markets.splice(duplicate, 1);
    markets.unshift(atd);
  }
  const source = stale && props.length ? "stale" : result.source;
  const data = { game_key: `${away}@${home}`, away, home, season, week, source, stale,
    complete: result.complete, live: markets.length > 0, markets, fetched_at: new Date().toISOString(),
    sharp_event_ids: result.ids, pages: result.pages };
  const entry = { key, ts: Date.now(), expires: Date.now() + (stale ? RETRY_MS : TTL_MS), data };
  cache.set(key, entry);
  persist(edge, propKey(key, "fresh"), entry, stale ? RETRY_MS / 1000 : TTL_MS / 1000, waitUntil);
  if (result.complete && props.length) persist(edge, propKey(key, "last"), { key, ts: Date.now(), props }, LASTGOOD_TTL_S, waitUntil);
  // Bound memory when anonymous callers supply many distinct game keys.
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return data;
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
  const url = new URL(request.url);
  if (url.searchParams.has("debug") && (!env.CRON_SECRET || request.headers.get("X-Cron-Secret") !== env.CRON_SECRET)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const gameKey = url.searchParams.get("game_key") || "";
  const parts = gameKey.split("@");
  const [away, home] = parts;
  if (parts.length !== 2 || !away || !home || gameKey.length > 160) {
    return json({ error: "missing-game_key", markets: [] }, { status: 400 });
  }
  const { season, week } = pickWeek(env);
  const key = `${season}:${week}:${away}@${home}`;
  let job = inFlight.get(key);
  if (!job) {
    job = loadGame(context, key, away, home, season, week).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  const data = await job;
  return json(data, { headers: { "Cache-Control": "no-store", "X-Prop-Source": data.source } });
}
