// /api/game?key=<away@home> — live drill-down for one War Room pick.
// Returns the game's live score/state/clock plus a compact set of player-stat
// leaders (passing/rushing/receiving per team) from the ESPN summary. Lazy:
// only hit when a member actually opens a pick, so the board stays light.
// Login required, mirrors /api/warroom.
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek, seasonTypeFor } from "../_shared/nfl.js";
import { fetchScoreboard, sameTeam } from "../_shared/grader.js";
import { PROP_DEFS, playerStatMap } from "../_shared/props.js";
import { espnSummary } from "../_shared/espn.js";

const TTL_MS = 25 * 1000;
const cache = new Map(); // `${season}:${week}:${key}` -> { ts, data }

// ESPN summary leaders -> [{ team, rows: [{ cat, name, line }] }] grouped per
// team (away, home order), so the client can render two tidy stat columns.
// Only the three positions people actually care about in a pick league.
const CATS = { passingYards: "PASS", rushingYards: "RUSH", receivingYards: "REC" };
function parseLeaders(gp) {
  const groups = [];
  for (const grp of gp.leaders || []) {
    const team = grp.team?.abbreviation || grp.team?.abbrev || "";
    const rows = [];
    for (const cat of grp.leaders || []) {
      const lab = CATS[cat.name];
      if (!lab) continue;
      const top = cat.leaders?.[0];
      const ath = top?.athlete;
      if (!ath) continue;
      rows.push({ cat: lab, name: ath.shortName || ath.displayName || "", line: top.displayValue || "" });
    }
    if (rows.length) groups.push({ team, rows });
  }
  return groups;
}

export function parsePlayerProgress(gp) {
  const names = new Set((gp.boxscore?.players || []).flatMap(t => (t.statistics || []).flatMap(c => (c.athletes || []).map(a => a.athlete?.displayName).filter(Boolean))));
  return [...names].map(name => {
    const stats = playerStatMap(gp.boxscore, name) || {};
    const markets = {};
    for (const [market, def] of Object.entries(PROP_DEFS)) {
      if (def.stat.some(k => Number.isFinite(stats[k]))) {
        markets[market] = { actual: def.stat.reduce((sum, k) => sum + (Number.isFinite(stats[k]) ? stats[k] : 0), 0), unit: def.unit };
      }
    }
    return { name, markets };
  });
}

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key || !key.includes("@")) return json({ error: "bad-key" }, { status: 400 });

  const cur = currentNflWeek(new Date(), env);
  if (!cur.week) return json({ found: false });

  const cacheKey = `${cur.season}:${cur.week}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < TTL_MS) return json(hit.data, { headers: { "X-Cache": "HIT" } });

  try {
    const events = await fetchScoreboard(cur.season, cur.week, seasonTypeFor(env), env);
    const [aKey, hKey] = key.split("@");
    const ev = events.find((e) => sameTeam(e.away, aKey) && sameTeam(e.home, hKey));
    if (!ev) return json({ found: false, key });

    const gameLive = ev.state === "in" || ev.state === "post";
    let leaders = [], situation = null, lastPlay = null, players = [], statsUpdatedAt = null;
    if (gameLive && ev.id) {
      const gp = await espnSummary(ev.id, env).catch(() => null);
      if (gp) {
        leaders = parseLeaders(gp);
        statsUpdatedAt = gp.source_updated_at || null;
        players = parsePlayerProgress(gp);
        const sit = gp.situation || gp.header?.competitions?.[0]?.situation;
        situation = sit?.downDistanceText || null;
        lastPlay = sit?.lastPlay?.text || null;
      }
    }

    const data = {
      found: true, key, state: ev.state, status: ev.status, detail: ev.detail || null,
      kickoff: ev.kickoff || null,
      away: { name: ev.away, score: ev.away_score },
      home: { name: ev.home, score: ev.home_score },
      leaders, situation, lastPlay, players, stats_updated_at: statsUpdatedAt,
      source_updated_at: ev.source_updated_at || null,
      fetched_at: new Date().toISOString(),
    };
    cache.set(cacheKey, { ts: Date.now(), data });
    return json(data, { headers: { "X-Cache": "MISS" } });
  } catch (e) {
    return json({ found: false, error: e.message }, { status: 502 });
  }
}
