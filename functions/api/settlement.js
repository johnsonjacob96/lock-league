// /api/settlement — the weekly $5-to-the-winner ledger (Article 6a).
//
// The site never touches money: it computes who owes the weekly winner, tracks
// paid/unpaid, and the client builds one-tap Venmo deep links from each member's
// handle. The season pot ($100 entry, $500/$200/$100) stays on LeagueSafe.
//
//   GET  ?season=            -> ledger: weekly winners + dues + members' handles
//   POST ?action=set-venmo   -> caller sets their own Venmo handle
//   POST ?action=mark-paid   -> mark a due paid/unpaid (payer or that week's winner)
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek } from "../_shared/nfl.js";
import { ensureExtras } from "../_shared/migrations.js";

const BET_TYPES = ["Favorite", "Dog", "Over", "Under", "Super Lock"];
const WEEKLY_AMOUNT = 5;

// Weekly winner from graded picks: unique best W (fewest L breaks ties). Ties
// stay open (no winner) — mirrors the client + grader logic exactly.
function computeWeeklyWinners(picks) {
  const byWeek = new Map();
  for (const p of picks) {
    if (!byWeek.has(p.week)) byWeek.set(p.week, new Map());
    const wk = byWeek.get(p.week);
    let m = wk.get(p.member_id);
    if (!m) { m = { member_id: p.member_id, name: p.name, w: 0, l: 0, any: false }; wk.set(p.member_id, m); }
    if (p.result === "W") { m.w++; m.any = true; }
    else if (p.result === "L") { m.l++; m.any = true; }
    else if (p.result === "P") { m.any = true; }
  }
  const winners = {};
  for (const [week, wk] of byWeek) {
    let best = null, tied = false;
    for (const m of wk.values()) {
      if (!m.any) continue;
      if (!best || m.w > best.w || (m.w === best.w && m.l < best.l)) { best = m; tied = false; }
      else if (m.w === best.w && m.l === best.l) tied = true;
    }
    winners[week] = (best && !tied && best.w > 0) ? { member_id: best.member_id, name: best.name, w: best.w, l: best.l } : null;
  }
  return winners;
}

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
  await ensureExtras(env);
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (request.method === "POST" && action === "set-venmo") {
    const body = await request.json().catch(() => ({}));
    let h = String(body.handle || "").trim().replace(/^@+/, "");
    if (h && !/^[A-Za-z0-9_-]{4,30}$/.test(h)) {
      return json({ error: "bad-handle", detail: "4–30 letters, numbers, - or _" }, { status: 400 });
    }
    await sql(env)`UPDATE members SET venmo_handle = ${h || null} WHERE id = ${memberId}`;
    return json({ ok: true, venmo_handle: h || null });
  }

  if (request.method === "POST" && action === "mark-paid") {
    const body = await request.json().catch(() => ({}));
    const { season, week } = body;
    const targetId = Number(body.member_id);
    const paid = !!body.paid;
    if (!season || !week || !targetId) return json({ error: "bad-body" }, { status: 400 });
    const row = (await sql(env)`SELECT winner_id FROM weekly_dues WHERE season = ${season} AND week = ${week} LIMIT 1`)[0];
    // Only the payer themselves or that week's winner can flip a due.
    if (memberId !== targetId && memberId !== row?.winner_id) return json({ error: "forbidden" }, { status: 403 });
    const res = await sql(env)`
      UPDATE weekly_dues SET paid = ${paid}, paid_at = ${paid ? new Date().toISOString() : null}
      WHERE season = ${season} AND week = ${week} AND member_id = ${targetId}
      RETURNING member_id`;
    if (!res.length) return json({ error: "no-such-due" }, { status: 404 });
    return json({ ok: true, paid });
  }

  if (request.method === "GET") {
    const season = Number(url.searchParams.get("season")) || currentNflWeek(new Date(), env).season || 2026;
    const members = await sql(env)`SELECT id, name, venmo_handle FROM members ORDER BY name`;
    const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
    const picks = await sql(env)`
      SELECT p.member_id, m.name, p.week, p.result
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${season} AND p.result IS NOT NULL`;
    const winners = computeWeeklyWinners(picks);

    const existing = await sql(env)`SELECT week, member_id, winner_id, amount, paid, paid_at FROM weekly_dues WHERE season = ${season}`;
    const byWeek = {};
    for (const d of existing) (byWeek[d.week] ||= []).push(d);

    // Reconcile: create dues for a newly-decided week; if the winner flips before
    // anyone has paid, rebuild that week's dues around the new winner.
    for (const [wkStr, winner] of Object.entries(winners)) {
      if (!winner) continue;
      const week = Number(wkStr);
      const rows = byWeek[week] || [];
      const anyPaid = rows.some((r) => r.paid);
      const staleWinner = rows.length && rows[0].winner_id !== winner.member_id;
      if (rows.length && !(staleWinner && !anyPaid)) continue; // already settled and correct
      if (staleWinner && !anyPaid) {
        await sql(env)`DELETE FROM weekly_dues WHERE season = ${season} AND week = ${week}`;
      }
      const owers = members.filter((m) => m.id !== winner.member_id);
      await Promise.all(owers.map((m) => sql(env)`
        INSERT INTO weekly_dues (season, week, member_id, winner_id, amount, paid)
        VALUES (${season}, ${week}, ${m.id}, ${winner.member_id}, ${WEEKLY_AMOUNT}, FALSE)
        ON CONFLICT (season, week, member_id) DO NOTHING`));
    }

    // Re-read after reconciliation so the response reflects any inserts.
    const dueRows = await sql(env)`SELECT week, member_id, winner_id, amount, paid, paid_at FROM weekly_dues WHERE season = ${season} ORDER BY week`;
    const duesByWeek = {};
    for (const d of dueRows) (duesByWeek[d.week] ||= []).push(d);

    const weeks = Object.keys(winners)
      .filter((w) => winners[w])
      .map(Number)
      .sort((a, b) => a - b)
      .map((week) => {
        const winner = winners[week];
        const dues = (duesByWeek[week] || []).map((d) => ({
          member_id: d.member_id, name: memberById[d.member_id]?.name || "?",
          paid: d.paid, paid_at: d.paid_at,
        })).sort((a, b) => a.name.localeCompare(b.name));
        return {
          week, winner_id: winner.member_id, winner_name: winner.name,
          winner_record: `${winner.w}-${winner.l}`, amount: WEEKLY_AMOUNT, dues,
        };
      });

    return json({
      season,
      me: { id: memberId, name: memberById[memberId]?.name || null, venmo_handle: memberById[memberId]?.venmo_handle || null },
      members: members.map((m) => ({ id: m.id, name: m.name, venmo_handle: m.venmo_handle || null })),
      weeks,
    });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
