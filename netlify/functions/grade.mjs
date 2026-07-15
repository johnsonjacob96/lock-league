// /api/grade — manual fire endpoint (HTTP-callable, requires CRON_SECRET).
// Scheduled runs live in grade-*-cron.mjs.
import { gradeWeek, gradeCurrentWeeks } from "../../lib/grader.js";

export default async (req) => {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret");
  const cronSecret = Netlify.env.get("CRON_SECRET");
  if (!cronSecret || secret !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const season = Number(url.searchParams.get("season"));
  const week = Number(url.searchParams.get("week"));
  try {
    if (season && week) {
      const result = await gradeWeek(season, week);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
    }
    // Default: grade the current week (games just finished) AND the previous
    // week (late finals / MNF caught by the Tuesday run after week rollover).
    const result = await gradeCurrentWeeks();
    if (!result.ran) return new Response(JSON.stringify({ ok: true, note: "offseason" }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
