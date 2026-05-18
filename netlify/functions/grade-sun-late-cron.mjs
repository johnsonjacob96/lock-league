// Scheduled grader run #3 — Monday 01:30 UTC.
// Catches Sun late slate (4:25pm ET kickoffs, ends ~7:45pm ET = 23:45 UTC Sun - 00:45 UTC Mon).
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
  schedule: "30 1 * * 1",
};
