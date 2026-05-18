// Scheduled grader run #2 — Sunday 22:00 UTC.
// Catches Sun early slate (1pm ET kickoffs, ends ~4:15pm ET = 20:15-21:15 UTC).
import { gradeWeek } from "../../lib/grader.js";
import { currentNflWeek } from "../../lib/nfl.js";

export default async () => {
  const cur = currentNflWeek();
  if (!cur.week) return new Response("offseason");
  try {
    const r = await gradeWeek(cur.season, cur.week);
    return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  schedule: "0 22 * * 0",
};
