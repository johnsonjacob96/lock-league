// /api/scores — live scores for the current week from the ESPN scoreboard.
// Free, no key; cached 60s per warm container. Powers the LIVE pills and
// in-progress scores on the This Week board.
import { currentNflWeek } from "../../lib/nfl.js";
import { fetchScoreboard } from "../../lib/grader.js";

const TTL_MS = 60 * 1000;
let cache = { ts: 0, key: "", data: null };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async () => {
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
};
