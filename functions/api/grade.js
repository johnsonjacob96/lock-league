// /api/grade — manual + cron-callable grading endpoint.
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
// GitHub Actions cron workflow hits this 4x/week during the season.
import { gradeWeek } from "../_shared/grader.js";
import { currentNflWeek } from "../_shared/nfl.js";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const secret = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  let season = Number(url.searchParams.get("season"));
  let week = Number(url.searchParams.get("week"));
  if (!season || !week) {
    const cur = currentNflWeek();
    if (!cur.week) return json({ ok: true, note: "offseason" });
    season = cur.season;
    week = Math.max(1, cur.week - 1);
  }
  try {
    const result = await gradeWeek(env, season, week);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ error: e.message }, { status: 500 });
  }
}
