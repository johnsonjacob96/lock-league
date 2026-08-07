// /api/config — tiny client bootstrap: the current pick week + flags, computed
// server-side so the client agrees with the backend even in preseason test mode
// (where the week is not derivable from the client's calendar math alone).
import { json } from "../_shared/auth.js";
import { currentNflWeek, pickCutoff, testConfig } from "../_shared/nfl.js";

export async function onRequest({ env }) {
  const cur = currentNflWeek(new Date(), env);
  const tc = testConfig(env);
  return json({
    season: cur.season,
    week: cur.week,
    status: cur.status,
    preseasonTest: !!tc,
    cutoff: cur.week ? pickCutoff(cur.season, cur.week, env).toISOString() : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
