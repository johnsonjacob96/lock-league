// /api/grade — manual fire endpoint (HTTP-callable, requires CRON_SECRET).
// Scheduled runs live in grade-*-cron.mjs.
import { gradeWeek } from "../../lib/grader.js";
import { currentNflWeek } from "../../lib/nfl.js";

export default async (req) => {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret");
  const cronSecret = Netlify.env.get("CRON_SECRET");
  if (!cronSecret || secret !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  let season = Number(url.searchParams.get("season"));
  let week = Number(url.searchParams.get("week"));
  if (!season || !week) {
    const cur = currentNflWeek();
    if (!cur.week) return new Response(JSON.stringify({ ok: true, note: "offseason" }), { headers: { "Content-Type": "application/json" } });
    season = cur.season;
    week = Math.max(1, cur.week - 1);
  }
  try {
    const result = await gradeWeek(season, week);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
