// /api/warroom — live Sunday leaderboard. Joins the current week's locked picks
// with the live ESPN scoreboard and computes each member's live record using the
// same grading math as the auto-grader. Login required; picks stay hidden until
// the weekly lock (noon CT Sunday), same as everywhere else.
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek, pickCutoff, seasonTypeFor } from "../_shared/nfl.js";
import { fetchScoreboard, resolveSpreadResult, gradeTotal, sameTeam } from "../_shared/grader.js";
import { sql } from "../_shared/db.js";

const TTL_MS = 40 * 1000;
let cache = { ts: 0, key: "", data: null };

// Live standing of one pick against the (possibly in-progress) game.
function livePickStatus(p, ev) {
  if (!ev) return { status: "pending", state: "pre" };
  const st = ev.state; // 'pre' | 'in' | 'post'
  if (st === "pre" || ev.home_score == null || ev.away_score == null) {
    return { status: "pending", state: st, detail: ev.detail };
  }
  if (p.bet_type === "Super Lock") {
    // Player props / specialty: can't auto-grade, mark manual.
    return { status: "manual", state: st, detail: ev.detail, final: st === "post" };
  }
  let result = null;
  if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
    result = resolveSpreadResult(p, ev);
  } else if (p.bet_type === "Over" || p.bet_type === "Under") {
    result = gradeTotal(p.side, Number(p.line), ev.home_score + ev.away_score);
  }
  const map = { W: "win", L: "lose", P: "push" };
  return { status: result ? map[result] : "pending", state: st, final: st === "post", detail: ev.detail };
}

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });

  const cur = currentNflWeek(new Date(), env);
  if (!cur.week) return json({ season: cur.season, week: null, status: cur.status, revealed: false, members: [] });

  const cutoff = pickCutoff(cur.season, cur.week, env);
  const revealed = Date.now() >= cutoff.getTime();
  if (!revealed) {
    return json({ season: cur.season, week: cur.week, revealed: false, cutoff: cutoff.toISOString() });
  }

  const key = `${cur.season}:${cur.week}`;
  if (cache.data && cache.key === key && Date.now() - cache.ts < TTL_MS) {
    return json({ ...cache.data, cached: true });
  }

  const [picks, events] = await Promise.all([
    sql(env)`
      SELECT p.member_id, m.name, p.bet_type, p.pick_text, p.game_key, p.side, p.line, p.result
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${cur.season} AND p.week = ${cur.week}
      ORDER BY m.name`,
    fetchScoreboard(cur.season, cur.week, seasonTypeFor(env)).catch(() => []),
  ]);

  const findEv = (gameKey) => {
    if (!gameKey) return null;
    const [a, h] = gameKey.split("@");
    return events.find((e) => sameTeam(e.away, a) && sameTeam(e.home, h)) || null;
  };

  const byMember = new Map();
  for (const p of picks) {
    let m = byMember.get(p.member_id);
    if (!m) {
      m = { member_id: p.member_id, name: p.name, picks: [], live: { W: 0, L: 0, P: 0, pending: 0 } };
      byMember.set(p.member_id, m);
    }
    const ev = findEv(p.game_key);
    // Trust a stored result if already graded; otherwise compute live.
    let s;
    if (p.result === "W") s = { status: "win", final: true, state: "post" };
    else if (p.result === "L") s = { status: "lose", final: true, state: "post" };
    else if (p.result === "P") s = { status: "push", final: true, state: "post" };
    else s = livePickStatus(p, ev);

    m.picks.push({
      bet_type: p.bet_type,
      pick_text: p.pick_text,
      status: s.status,
      final: !!s.final,
      state: s.state || null,
      detail: s.detail || (ev && ev.detail) || null,
      score: ev && ev.away_score != null
        ? { away: ev.away, home: ev.home, away_score: ev.away_score, home_score: ev.home_score }
        : null,
    });

    if (s.status === "win") m.live.W++;
    else if (s.status === "lose") m.live.L++;
    else if (s.status === "push") m.live.P++;
    else m.live.pending++;
  }

  const members = [...byMember.values()].sort(
    (a, b) => b.live.W - a.live.W || a.live.L - b.live.L || a.name.localeCompare(b.name));
  const anyLive = events.some((e) => e.state === "in");

  // Recap: once every game this week is final, summarize the week.
  let recap = null;
  const allFinal = events.length > 0 && events.every((e) => e.state === "post");
  if (allFinal && members.length) {
    const top = members[0];
    const tie = members.filter((m) => m.live.W === top.live.W && m.live.L === top.live.L).length > 1;
    const winner = !tie && top.live.W > 0 ? { name: top.name, W: top.live.W, L: top.live.L } : null;
    const perfect = members
      .filter((m) => m.live.W > 0 && m.live.L === 0 && m.live.pending === 0)
      .map((m) => m.name);
    recap = { complete: true, winner, tie, perfect };
  }

  const data = { season: cur.season, week: cur.week, revealed: true, fetched_at: new Date().toISOString(), anyLive, members, recap };
  cache = { ts: Date.now(), key, data };
  return json(data);
}
