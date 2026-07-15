// /api/grade — manual + cron-callable grading endpoint.
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
// GitHub Actions cron workflow hits this 4x/week during the season.
import { gradeWeek, gradeCurrentWeeks } from "../_shared/grader.js";

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
  const season = Number(url.searchParams.get("season"));
  const week = Number(url.searchParams.get("week"));
  try {
    if (season && week) {
      const result = await gradeWeek(env, season, week);
      return json({ ok: true, ...result });
    }
    // Default: grade the current week (games just finished) AND the previous
    // week (late finals / MNF caught by the Tuesday run after week rollover).
    const result = await gradeCurrentWeeks(env);
    if (!result.ran) return json({ ok: true, note: "offseason" });
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ error: e.message }, { status: 500 });
  }
}
