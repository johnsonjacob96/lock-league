// /api/scores — live scores for the current week from the ESPN scoreboard.
// Free, no key; cached 60s per warm isolate. Powers the LIVE pills and
// in-progress scores on the This Week board.
import { json } from "../_shared/auth.js";
import { currentNflWeek, seasonTypeFor, testConfig } from "../_shared/nfl.js";
import { fetchScoreboard, maybeGrade } from "../_shared/grader.js";

const TTL_MS = 60 * 1000;
let cache = { ts: 0, key: "", data: null };

export async function onRequestGet(context) {
  const env = context && context.env;
  // Grade newly-final games in the background as the board is polled.
  if (context && context.waitUntil) context.waitUntil(maybeGrade(env).catch(() => {}));
  const cur = currentNflWeek(new Date(), env);
  if (!cur.week) return json({ season: cur.season, week: null, games: [] });
  const key = `${cur.season}:${cur.week}:${seasonTypeFor(env)}`;
  if (cache.data && cache.key === key && Date.now() - cache.ts < TTL_MS) {
    return json(cache.data, { headers: { "X-Cache": "HIT", "Cache-Control": "public, max-age=30" } });
  }
  try {
    const games = await fetchScoreboard(cur.season, cur.week, seasonTypeFor(env), env);
    const data = { season: cur.season, week: cur.week, fetched_at: new Date().toISOString(), games, test: !!testConfig(env) };
    cache = { ts: Date.now(), key, data };
    return json(data, { headers: { "X-Cache": "MISS", "Cache-Control": "public, max-age=30" } });
  } catch (e) {
    return json({ error: e.message, games: [] }, { status: 502 });
  }
}
