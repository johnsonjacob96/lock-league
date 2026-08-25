// Live prod health probe (opt-in: --live). Hits the deployed endpoints and asserts
// the things that have actually broken in production: the odds board serving sane
// totals (no team-total leak), props live for the games that have them, and the
// core read endpoints returning 2xx. Catches deploy/feed regressions the offline
// layers can't see. Never writes anything.
import { suite } from "./assert.mjs";

const j = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json().catch(() => null) }; };

export async function run(base = "https://lock-league.pages.dev") {
  const s = suite(`live — prod health probe (${base})`);

  // Odds board: real games + sane totals (the team-total-leak regression).
  const odds = await j(`${base}/api/odds?season=2026&week=1`);
  s.ok("/api/odds 200", odds.status === 200, `status ${odds.status}`);
  const games = odds.body?.games || [];
  s.ok("board has NFL games", games.length >= 1, `games=${games.length}`);
  const totals = games.map(g => { const b = g.books || {}; let mn = null; for (const k of Object.keys(b)) { const t = b[k].total; if (t && (mn == null || t.point < mn)) mn = t.point; } return mn; }).filter(x => x != null);
  s.ok("every game total is a real game line (>= 30, no team/period leak)", totals.every(t => t >= 30),
    `low totals: ${totals.filter(t => t < 30).join(", ")}`);

  // Props: for any game the board lists, /api/props must not 5xx; at least the open
  // games return a well-formed (possibly empty) menu.
  const g0 = games[0];
  if (g0) {
    const key = encodeURIComponent(`${g0.away}@${g0.home}`);
    const pr = await j(`${base}/api/props?game_key=${key}`);
    s.ok("/api/props 200 + well-formed", pr.status === 200 && Array.isArray(pr.body?.markets), `status ${pr.status}`);
    // If props are live, players must have names (not "Over"/"Under") and alt arrays.
    const anyMkt = (pr.body?.markets || [])[0];
    if (anyMkt) s.ok("live prop players have real names + alts array", anyMkt.players.every(p => p.player && !/^over$|^under$/i.test(p.player) && Array.isArray(p.alts)));
  }

  // Core read endpoints are alive (not missing, not server-erroring). Some are
  // auth-gated, so a 401/403 is a healthy response — only 404 (missing) or 5xx
  // (broken) is a failure.
  for (const [name, path] of [["picks", "/api/picks?season=2026&week=1"], ["warroom", "/api/warroom"], ["standings", "/api/standings"]]) {
    const r = await fetch(`${base}${path}`).catch(() => null);
    if (r) s.ok(`/api/${name} alive (not 404/5xx)`, r.status !== 404 && r.status < 500, `status ${r.status}`);
    else s.ok(`/api/${name} alive (not 404/5xx)`, false, "no response");
  }

  return s;
}
