import { sharedFeed } from "../_shared/feed-cache.js";
import { loadScoreboardSeed } from "../_shared/scoreseed.js";
// /api/odds — live NFL spreads + totals.
//
// Sources, in order:
//   1. The Odds API  — FanDuel + DraftKings, per-side prices (the real thing)
//   2. ESPN scoreboard — free consensus line, used when The Odds API is down,
//      out of credits, or not enabled yet (so the board is never empty)
//   3. Neon last-good snapshot — served stale only if every live source fails
//
// A global Postgres lease/budget coordinates all colos ahead of the existing
// cache layers. Delivery is layered so a burst of pickers never becomes a burst of upstream
// calls: L1 warm-isolate memory, L2 colo-shared Cache API, L3 Neon snapshot.
// Freshness (ODDS_TTL_S, default 60s) is tuned for live line movement — the
// client polls on top of this while the board is open.
import { json } from "../_shared/auth.js";
import { sql, ignoringConcurrentCreate } from "../_shared/db.js";
import { weekWindow } from "../_shared/nfl.js";
import { saveScoreboardSeed, saveSummarySeed } from "../_shared/scoreseed.js";

import { currentSeasonWeek, fetchOddsApi, fetchEspn, fetchSharpApi, normalizeEspnEvents } from "../_shared/odds-providers.js";
export { normalizeEspnEvents, normalizeSharp, fetchSharpRaw } from "../_shared/odds-providers.js";
import { oddsDiagnostics } from "../_shared/odds-diagnostics.js";

// Synthetic, cookie-free key for the shared Cache API entry.
const EDGE_KEY = new Request("https://lock-league.internal/cache/odds-v2");
let cache = { ts: 0, data: null };

function ttlSeconds(env) {
  const n = Number(env?.ODDS_TTL_S);
  return Number.isFinite(n) && n >= 15 ? n : 60; // floor at 15s to protect quota
}

// Supplement incomplete primary coverage without spending backup quota per
// browser/colo. Postgres grants one refresh attempt per pick week per 15 minutes.
const BACKUP_TTL_MS = 15 * 60 * 1000;
let backupReady = false;
const completeMarket = (m, type) => !!m && (type === "spread"
  ? Number.isFinite(m.line) && Number.isFinite(m.favPrice) && Number.isFinite(m.dogPrice)
  : Number.isFinite(m.point) && Number.isFinite(m.overPrice) && Number.isFinite(m.underPrice));
// Main totals should not differ by ten points between books. Do not guess
// which is right: confirm from the independent feed or withhold both totals.
function conflictingTotals(g) {
  const a = g.books?.fanduel?.total?.point, b = g.books?.draftkings?.total?.point;
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= 10;
}
export function quarantineConflictingTotals(payload) {
  if (!payload?.games?.some(conflictingTotals)) return payload;
  return { ...payload, games: payload.games.map(g => !conflictingTotals(g) ? g : { ...g,
    books: Object.fromEntries(Object.entries(g.books || {}).map(([key,book]) =>
      [key, ["fanduel","draftkings"].includes(key) ? { ...book, total: null, total_unavailable_reason: "conflicting-provider-lines" } : book]))
  }) };
}
const freshBook = (book, now) => !!book && Number.isFinite(Date.parse(book.updated)) && now - Date.parse(book.updated) <= BACKUP_TTL_MS;
function corroboratedTotals(g, now) {
  const a = g.books?.fanduel, b = g.books?.draftkings;
  return freshBook(a, now) && freshBook(b, now) && completeMarket(a.total,"total") && completeMarket(b.total,"total") && Math.abs(a.total.point-b.total.point) <= 3;
}
export function needsBookSupplement(payload) {
  return (payload.games || []).some(g => conflictingTotals(g) || ["fanduel", "draftkings"].some(b =>
    ["spread", "total"].some(m => !completeMarket(g.books?.[b]?.[m], m))));
}
export function mergeBookSupplement(primary, backup, now = Date.now()) {
  if (!backup || now - Date.parse(backup.fetched_at) > BACKUP_TTL_MS || !Number.isFinite(Date.parse(backup.fetched_at))) return quarantineConflictingTotals(primary);
  const byGame = new Map((backup.games || []).map(g => [`${g.away}@${g.home}`, g]));
  return quarantineConflictingTotals({ ...primary, games: primary.games.map(g => {
    const extra = byGame.get(`${g.away}@${g.home}`);
    if (!extra || !Number.isFinite(Date.parse(extra.kickoff)) || !Number.isFinite(Date.parse(g.kickoff)) || Math.abs(Date.parse(extra.kickoff) - Date.parse(g.kickoff)) > 3600000) return g;
    const books = { ...g.books };
    for (const key of ["fanduel", "draftkings"]) {
      const candidate = extra.books?.[key];
      if (!candidate || !Number.isFinite(Date.parse(candidate.updated)) || now - Date.parse(candidate.updated) > BACKUP_TTL_MS) continue;
      for (const market of ["spread", "total"]) {
        if (!completeMarket(books[key]?.[market], market) && completeMarket(candidate[market], market)) {
          books[key] = { ...books[key], [market]: candidate[market], updated: candidate.updated, supplemental: true };
        }
      }
    }
    // Check after filling gaps too: a missing primary book can conceal the
    // disagreement until its backup quote has been added.
    if (conflictingTotals({ books }) && corroboratedTotals(extra, now)) {
      for (const key of ["fanduel", "draftkings"]) {
        books[key] = { ...books[key], total: extra.books[key].total,
          updated: extra.books[key].updated, supplemental: true };
        delete books[key].total_unavailable_reason;
      }
    }
    return { ...g, books };
  }) });
}
async function fetchSharedBackup(env) {
  if (!env.ODDS_API_KEY || !env.DATABASE_URL) return null;
  try {
    const db = sql(env);
    if (!backupReady) {
      await ignoringConcurrentCreate(db`CREATE TABLE IF NOT EXISTS odds_backup_snapshot (
        cache_key TEXT PRIMARY KEY, payload JSONB, attempted_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
      )`);
      backupReady = true;
    }
    const cur = currentSeasonWeek(env), key = `${cur.season}:${cur.week}`;
    await db`INSERT INTO odds_backup_snapshot (cache_key) VALUES (${key}) ON CONFLICT DO NOTHING`;
    const claim = await db`UPDATE odds_backup_snapshot SET attempted_at = NOW()
      WHERE cache_key = ${key} AND attempted_at <= NOW() - INTERVAL '15 minutes' RETURNING cache_key`;
    let backup;
    if (claim.length) {
      try {
        backup = await fetchOddsApi(env);
        await db`UPDATE odds_backup_snapshot SET payload = ${JSON.stringify(backup)}::jsonb WHERE cache_key = ${key}`;
      } catch { /* The lease also backs off failed/quota-exhausted requests. */ }
    }
    if (!backup) {
      const rows = await db`SELECT payload FROM odds_backup_snapshot WHERE cache_key = ${key}`;
      backup = rows[0]?.payload;
    }
    const scoped = scopedPayload(backup, env);
    if (!scoped || !Number.isFinite(Date.parse(scoped.fetched_at)) || Date.now() - Date.parse(scoped.fetched_at) > BACKUP_TTL_MS) return null;
    return scoped;
  } catch { return null; }
}
export async function supplementMissingBooks(env, primary) {
  if (!needsBookSupplement(primary)) return primary;
  return mergeBookSupplement(primary, await fetchSharedBackup(env));
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
    return true;
  } catch { return false; }
}
async function loadSnapshot(env) {
  try {
    const rows = await sql(env)`SELECT payload, fetched_at FROM odds_snapshot WHERE id = 1`;
    if (rows.length) {
      const p = scopedPayload(rows[0].payload, env);
      if (!p) return null;
      // Persisted odds are a last-good fallback, including manually seeded odds.
      return { ...p, live: false, stale: true, snapshot_at: rows[0].fetched_at };
    }
  } catch { /* none yet */ }
  return null;
}

// All cache layers must agree with the active pick week, including at rollover.
export function scopedPayload(payload, env) {
  if (!payload || payload.source === "mock" || !Array.isArray(payload.games)) return null;
  const { season, week } = currentSeasonWeek(env);
  if ((payload.season != null && payload.season !== season) ||
      (payload.week != null && payload.week !== week)) return null;
  const window = weekWindow(week, env);
  const start = Date.parse(window.from), end = Date.parse(window.to);
  const games = payload.games.filter(g => {
    const t = Date.parse(g.kickoff);
    return Number.isFinite(t) && t >= start && t < end;
  });
  return games.length ? quarantineConflictingTotals({ ...payload, season, week, games }) : null;
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

export async function getUnshared(context, coordinated = false) {
  const { request, env } = context;
  const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : () => {};
  const url = new URL(request.url);
  const requestedFresh = url.searchParams.get("fresh") === "1";
  const wantMock = url.searchParams.get("mock") === "1";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const admin = !!env.CRON_SECRET && request.headers.get("X-Cron-Secret") === env.CRON_SECRET;
  const force = coordinated || (requestedFresh && (local || admin));
  if ((wantMock || url.searchParams.has("debug")) && !local && !admin) {
    return json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (wantMock) return json(mockPayload(), hdr("MOCK")); // never enter shared caches
  const primary = primaryProvider(env);
  const ttlS = ttlSeconds(env);
  const ttlMs = ttlS * 1000;

  const diagnostic = await oddsDiagnostics(env, url);
  if (diagnostic) return diagnostic;

  // L1 — warm-isolate memory.
  const memory = scopedPayload(cache.data, env);
  if (!force && memory && Date.now() - cache.ts < ttlMs) return json(memory, hdr("HIT-MEM"));

  // L2 — colo-shared cache (misses once past ttlS).
  const edge = caches.default;
  if (!force) {
    try {
      const cached = await edge.match(EDGE_KEY);
      if (cached) {
        const payload = scopedPayload(await cached.json(), env);
        if (payload) {
          cache = { ts: Date.now(), data: payload };
          return json(payload, hdr("HIT-EDGE"));
        }
      }
    } catch { /* fall through */ }
  }

  // Source 1 — primary FD/DK feed (The Odds API or SharpAPI, per ODDS_PROVIDER).
  // Snapshotted so it can be served stale later.
  if (primary) {
    try {
      let payload = await fetchPrimary(env, primary);
      if (primary === "sharpapi") payload = await supplementMissingBooks(env, payload);
      payload = quarantineConflictingTotals(payload);
      // An empty board means "no lines posted yet" or a malformed response,
      // never "no games this week" — always fall through to the ESPN board
      // instead of returning/snapshotting a blank one. (This used to only
      // fall through during the preseason test window, so during the regular
      // season an empty-but-200 primary response was accepted as success and
      // overwrote the last-good snapshot, poisoning the stale fallback too.)
      if (payload.locked || (payload.games && payload.games.length)) {
        cache = { ts: Date.now(), data: payload };
        waitUntil(putEdge(edge, payload, ttlS));
        waitUntil(saveSnapshot(env, payload));
        return json(payload, hdr("MISS-" + primary.toUpperCase(), payload.remaining ? { "X-Odds-Remaining": payload.remaining } : {}));
      }
    } catch { /* fall through to ESPN */ }
  }

  // A primary outage must not replace real FD/DK prices with ESPN consensus.
  // Reuse the same quota-limited backup as partial coverage, then the last-good
  // bookmaker snapshot. ESPN remains the last resort when neither is available.
  if (primary === "sharpapi") {
    const backup = await fetchSharedBackup(env);
    if (backup?.games?.length) {
      const payload = { ...backup, games: backup.games.map(g => ({ ...g,
        books: Object.fromEntries(Object.entries(g.books || {}).map(([k,b]) => [k,{...b,supplemental:true}])) })) };
      cache = { ts: Date.now(), data: payload };
      waitUntil(putEdge(edge, payload, ttlS));
      waitUntil(saveSnapshot(env, payload));
      return json(payload, hdr("MISS-BACKUP"));
    }
    const last = await loadSnapshot(env);
    if (last && ["sharpapi", "the-odds-api"].includes(last.source)) {
      cache = { ts: Date.now(), data: last };
      return json(last, hdr("STALE-BOOKS"));
    }
  }

  // Source 2 — ESPN consensus (free). Primary on the no-key path, fallback otherwise.
  // Snapshot ESPN successes too: ESPN is flaky from the Worker, so persisting a
  // good board means one success (from any isolate) sticks for everyone instead
  // of each colo re-rolling against a 403/empty response and serving a stale
  // (possibly wrong-week) snapshot. This is the current-best board regardless of
  // source; a later SharpAPI success overwrites it with FD/DK.
  try {
    const payload = await fetchEspn(env);
    const hasLines = payload.games.some(g => Object.values(g.books || {}).some(b => b.spread || b.total));
    if (!hasLines) {
      const last = await loadSnapshot(env);
      if (last?.games.some(g => Object.values(g.books || {}).some(b => b.spread || b.total))) {
        cache = { ts: Date.now(), data: last };
        return json(last, hdr("STALE"));
      }
    }
    cache = { ts: Date.now(), data: payload };
    waitUntil(putEdge(edge, payload, ttlS));
    if (hasLines) waitUntil(saveSnapshot(env, payload));
    return json(payload, hdr(primary ? "MISS-ESPN-FALLBACK" : "MISS-ESPN"));
  } catch { /* fall through */ }

  // Source 3 — last-good snapshot, then mock (no-key path), then error.
  const snap = await loadSnapshot(env);
  if (snap) {
    cache = { ts: Date.now(), data: snap };
    return json(snap, hdr("STALE"));
  }
  if (!primary && local) return json(mockPayload(), hdr("MISS-MOCK"));
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
  const rawEvents = Array.isArray(body.events) ? body.events : null;
  const season = Number(body.season), week = Number(body.week), seasontype = Number(body.seasontype);
  if (rawEvents && (!Number.isInteger(season) || season !== 2026 ||
      !Number.isInteger(week) || week < 1 || week > 18 || ![1, 2].includes(seasontype))) {
    return json({ error: "bad-period" }, { status: 400 });
  }
  const games = rawEvents ? normalizeEspnEvents(rawEvents, env)
    : (Array.isArray(body.games) ? body.games : null);
  if (!games?.length) return json({ error: "no-games" }, { status: 422 });

  // Score ingestion must never overwrite the independent live odds snapshot.
  // Legacy board seeds remain supported, but only for the current pick window.
  const payload = scopedPayload({ source: body.source || "espn", live: true, seeded: true,
    fetched_at: new Date().toISOString(), games, ...(rawEvents ? { season, week } : {}) }, env);
  let oddsSeeded = false;
  if (body.scoreboardOnly !== true && payload) {
    oddsSeeded = await saveSnapshot(env, payload);
    if (oddsSeeded) cache = { ts: Date.now(), data: payload };
  }
  let scoreboardSeeded = false;
  if (rawEvents) scoreboardSeeded = await saveScoreboardSeed(env, season, week, seasontype, rawEvents);
  const summaries = body.summaries && typeof body.summaries === "object" && !Array.isArray(body.summaries)
    ? Object.entries(body.summaries) : [];
  const eventIds = new Set((rawEvents || []).map(ev => String(ev.id)));
  let summariesSeeded = 0;
  for (const [eventId, summary] of summaries) {
    if (!eventIds.has(eventId) || !summary?.boxscore?.players?.length) {
      return json({ error: "bad-summary", eventId }, { status: 400 });
    }
    if (await saveSummarySeed(env, eventId, summary)) summariesSeeded++;
  }
  const ok = (rawEvents ? scoreboardSeeded : oddsSeeded) && summariesSeeded === summaries.length;
  return json({ ok, games: games.length, source: body.source || "espn", oddsSeeded, scoreboardSeeded,
    summariesSeeded }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

// The schedule owns the game list; a partial odds response owns only its quotes.
export function retainSchedule(payload, events) {
  const map = new Map((payload.games || []).map(g=>[`${g.away}@${g.home}`,g]));
  for(const ev of events || []) {
    const cs=ev.competitions?.[0]?.competitors || [];
    const home=cs.find(c=>c.homeAway==='home')?.team?.displayName;
    const away=cs.find(c=>c.homeAway==='away')?.team?.displayName;
    if(home && away && !map.has(`${away}@${home}`))map.set(`${away}@${home}`,{
      id:ev.id,home,away,kickoff:ev.date,books:{},odds_unavailable:true});
  }
  return {...payload,games:[...map.values()].sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff))};
}
export async function onRequestGet(context) {
  const url=new URL(context.request.url);
  if(!context.env?.DATABASE_URL || url.searchParams.has('debug') || url.searchParams.has('mock'))return getUnshared(context);
  const cur=currentSeasonWeek(context.env);
  try {
    const data=await sharedFeed(context.env,`board-v4:${cur.season}:${cur.week}`,30000,async()=>{
      const r=await getUnshared(context,true);const payload=await r.json();
      if(!r.ok)throw Error('odds-unavailable');
      const events=await loadScoreboardSeed(context.env,cur.season,cur.week,2);
      return retainSchedule(payload,events);
    });
    return json(data,hdr(data.stale?'SHARED-DELAYED':'SHARED'));
  } catch {
    const events=await loadScoreboardSeed(context.env,cur.season,cur.week,2);
    return json(retainSchedule({source:'unavailable',live:false,stale:true,games:[]},events),hdr('SCHEDULE'));
  }
}
