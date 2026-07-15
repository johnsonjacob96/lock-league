// Scheduled grader run — Monday 01:30 UTC — catches the Sun late slate.
// Grades the current week and the previous week (late finals).
import { gradeCurrentWeeks } from "../../lib/grader.js";

export default async () => {
  try {
    const r = await gradeCurrentWeeks();
    if (!r.ran) return new Response("offseason");
    return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  schedule: "30 1 * * 1",
};
