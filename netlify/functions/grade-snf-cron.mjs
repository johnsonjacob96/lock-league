// Scheduled grader run #4 — Monday 05:30 UTC.
// Catches Sunday Night Football (8:20pm ET kickoff, ends ~11:30pm ET = 03:30-04:30 UTC Mon).
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
  schedule: "30 5 * * 1",
};
