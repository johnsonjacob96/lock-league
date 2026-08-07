// /api/notify — cron-only push triggers.
//   ?type=reminder  -> Web Push to members with fewer than 5 picks for the
//                      current week, before the Sunday-noon-CT lock.
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
import { sql } from "../_shared/db.js";
import { currentNflWeek, pickCutoff } from "../_shared/nfl.js";
import { pushPersonalized } from "../_shared/push-notify.js";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export async function onRequest({ request, env }) {
  const secret = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "reminder";
  const cur = currentNflWeek();
  if (!cur.week) return json({ ok: true, note: cur.status });

  if (type === "reminder") {
    const rows = await sql(env)`
      SELECT m.id, m.name, COUNT(p.id)::int AS picks
      FROM members m
      LEFT JOIN picks p ON p.member_id = m.id AND p.season = ${cur.season} AND p.week = ${cur.week}
      GROUP BY m.id, m.name`;
    const behind = rows.filter((r) => r.picks < 5);
    if (!behind.length) return json({ ok: true, note: "everyone submitted" });

    const cutoff = pickCutoff(cur.season, cur.week);
    const timeStr = cutoff.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
    });
    const byMemberId = {};
    for (const r of behind) {
      const left = 5 - r.picks;
      byMemberId[r.id] = {
        title: `Week ${cur.week}: ${left} pick${left === 1 ? "" : "s"} to go`,
        body: r.picks === 0
          ? `You have not locked any picks yet. Lock closes at ${timeStr} CT Sunday.`
          : `You are ${r.picks} of 5 in. ${left} left before ${timeStr} CT Sunday.`,
        url: "/",
        tag: `ll-reminder-${cur.season}-${cur.week}`,
      };
    }
    const res = await pushPersonalized(env, byMemberId);
    return json({ ok: true, week: cur.week, reminded: behind.map((b) => b.name), ...res });
  }

  return json({ error: "unknown-type" }, { status: 400 });
}
