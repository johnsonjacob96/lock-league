// /api/settlement — the weekly payout ledger.
//
// The weekly game is PRE-FUNDED: every member sends the collector (Jared) a
// season buy-in up front (tracked in /api/pot). Each week the collector Venmos
// that week's winner the weekly prize. This endpoint computes the weekly winners
// and tracks whether the collector has paid each one yet (`weekly_payouts`). The
// site never touches money — it just says who the collector owes and builds the
// one-tap Venmo link. The season pot ($100 entry) is held + paid by LeagueSafe.
//
//   GET  ?season=            -> weekly winners + amount owed + paid status + handles
//   POST ?action=set-venmo   -> caller sets their own Venmo handle
//   POST ?action=mark-paid   -> mark a week's payout paid/unpaid (collector or that winner)
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek } from "../_shared/nfl.js";
import { ensureExtras } from "../_shared/migrations.js";

const DEFAULT_PRIZE = 40;

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
    const season = Number(body.season);
    const week = Number(body.week);
    const paid = !!body.paid;
    if (!season || !week) return json({ error: "bad-body" }, { status: 400 });
    // Only the collector or that week's winner can flip a payout.
    const cfg = (await sql(env)`SELECT collector_id FROM pot_config WHERE season = ${season} LIMIT 1`)[0];
    const graded = await sql(env)`
      SELECT p.member_id, m.name, p.week, p.result
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${season} AND p.week = ${week} AND p.result IS NOT NULL`;
    const winner = computeWeeklyWinners(graded)[week];
    if (!winner) return json({ error: "no-winner-yet" }, { status: 409 });
    if (memberId !== cfg?.collector_id && memberId !== winner.member_id) {
      return json({ error: "forbidden", detail: "only the collector or the winner can flip this" }, { status: 403 });
    }
    const at = paid ? new Date().toISOString() : null;
    await sql(env)`
      INSERT INTO weekly_payouts (season, week, paid, paid_at)
      VALUES (${season}, ${week}, ${paid}, ${at})
      ON CONFLICT (season, week) DO UPDATE SET paid = ${paid}, paid_at = ${at}`;
    return json({ ok: true, week, paid });
  }

  if (request.method === "GET") {
    const season = Number(url.searchParams.get("season")) || currentNflWeek(new Date(), env).season || 2026;
    const cfg = (await sql(env)`SELECT collector_id, weekly_prize FROM pot_config WHERE season = ${season} LIMIT 1`)[0];
    const prize = cfg?.weekly_prize != null ? Number(cfg.weekly_prize) : DEFAULT_PRIZE;
    const collectorId = cfg?.collector_id ?? null;

    const [members, picks, payoutRows] = await Promise.all([
      sql(env)`SELECT id, name, venmo_handle FROM members ORDER BY name`,
      sql(env)`
        SELECT p.member_id, m.name, p.week, p.result
        FROM picks p JOIN members m ON m.id = p.member_id
        WHERE p.season = ${season} AND p.result IS NOT NULL`,
      sql(env)`SELECT week, paid, paid_at FROM weekly_payouts WHERE season = ${season}`,
    ]);
    const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
    const winners = computeWeeklyWinners(picks);
    const paidByWeek = Object.fromEntries(payoutRows.map((r) => [r.week, r]));
    const collector = collectorId ? memberById[collectorId] : null;

    const weeks = Object.keys(winners)
      .filter((w) => winners[w])
      .map(Number)
      .sort((a, b) => a - b)
      .map((week) => {
        const winner = winners[week];
        const pr = paidByWeek[week];
        return {
          week,
          winner_id: winner.member_id,
          winner_name: winner.name,
          winner_record: `${winner.w}-${winner.l}`,
          winner_venmo: memberById[winner.member_id]?.venmo_handle || null,
          amount: prize,
          paid: !!pr?.paid,
          paid_at: pr?.paid_at || null,
        };
      });

    return json({
      season,
      prize,
      collector: collector ? { id: collector.id, name: collector.name, venmo_handle: collector.venmo_handle || null } : null,
      me: {
        id: memberId,
        name: memberById[memberId]?.name || null,
        venmo_handle: memberById[memberId]?.venmo_handle || null,
        is_collector: memberId === collectorId,
      },
      members: members.map((m) => ({ id: m.id, name: m.name, venmo_handle: m.venmo_handle || null })),
      weeks,
    });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
