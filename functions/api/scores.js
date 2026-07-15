// /api/scores — live scores for the current week from the ESPN scoreboard.
// Free, no key; cached 60s per warm isolate. Powers the LIVE pills and
// in-progress scores on the This Week board.
import { json } from "../_shared/auth.js";
import { currentNflWeek } from "../_shared/nfl.js";
import { fetchScoreboard } from "../_shared/grader.js";

const TTL_MS = 60 * 1000;
let cache = { ts: 0, key: "", data: null };

export async function onRequestGet() {
  const cur = currentNflWeek();
  if (!cur.week) return json({ season: cur.season, week: null, games: [] });
  const key = `${cur.season}:${cur.week}`;
  if (cache.data && cache.key === key && Date.now() - cache.ts < TTL_MS) {
    return json(cache.data, { headers: { "X-Cache": "HIT", "Cache-Control": "public, max-age=30" } });
  }
  try {
    const games = await fetchScoreboard(cur.season, cur.week);
    const data = { season: cur.season, week: cur.week, fetched_at: new Date().toISOString(), games };
    cache = { ts: Date.now(), key, data };
    return json(data, { headers: { "X-Cache": "MISS", "Cache-Control": "public, max-age=30" } });
  } catch (e) {
    return json({ error: e.message, games: [] }, { status: 502 });
  }
}
