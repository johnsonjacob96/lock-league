// Scheduled grader run #1 — Friday 05:30 UTC.
// Catches Thursday Night Football (typically ends ~11:30pm ET = 03:30-04:30 UTC).
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
  schedule: "30 5 * * 5",
};
