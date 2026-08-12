// /api/pot — season-pot tracker (Article 11: $100 entry, $500/$200/$100 payout).
//
// The site never holds money. This tracks who has paid their season entry, shows
// collection progress + payout structure, and builds a one-tap Venmo deep link to
// whoever is collecting the pot (the commissioner). Money moves peer-to-peer to
// the collector's own Venmo — the app has NO custody, exactly like the weekly $5
// settlement ledger. Real escrow (holding + auto-distributing the pot) needs a
// licensed money-transmitter rail, which is precisely what LeagueSafe provides;
// that is deliberately out of scope for a self-hosted friend-league app.
//
//   GET  ?season=          -> config + per-member paid status + progress
//   POST ?action=set-paid  -> mark a member's entry paid/unpaid (self, or the collector)
//   POST ?action=config    -> set collector/entry/deadline/payout (collector; or anyone if unset)
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek } from "../_shared/nfl.js";
import { ensureExtras } from "../_shared/migrations.js";

const DEFAULT_ENTRY = 100;
const DEFAULT_PAYOUT = [
  { place: 1, amount: 500 },
  { place: 2, amount: 200 },
  { place: 3, amount: 100 },
];

function seasonOf(env, url, body) {
  return (
    Number(url?.searchParams.get("season")) ||
    Number(body?.season) ||
    currentNflWeek(new Date(), env).season ||
    2026
  );
}

async function loadConfig(env, season) {
  const row = (await sql(env)`
    SELECT season, entry_amount, collector_id, deadline, payout
    FROM pot_config WHERE season = ${season} LIMIT 1`)[0];
  return {
    entry_amount: row?.entry_amount != null ? Number(row.entry_amount) : DEFAULT_ENTRY,
    collector_id: row?.collector_id ?? null,
    deadline: row?.deadline ?? null,
    payout: Array.isArray(row?.payout) ? row.payout : DEFAULT_PAYOUT,
    configured: !!row,
  };
}

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
  await ensureExtras(env);
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const season = seasonOf(env, url, body);
    const cfg = await loadConfig(env, season);
    const isCollector = cfg.collector_id === memberId;
    const unset = cfg.collector_id == null; // no collector yet -> any member may set up

    if (action === "set-paid") {
      const targetId = Number(body.member_id);
      const paid = !!body.paid;
      if (!targetId) return json({ error: "bad-body" }, { status: 400 });
      // A member can always flip their OWN entry; the collector can flip anyone's.
      if (memberId !== targetId && !isCollector) {
        return json({ error: "forbidden", detail: "only you or the pot collector can change this" }, { status: 403 });
      }
      const okMember = (await sql(env)`SELECT 1 FROM members WHERE id = ${targetId} LIMIT 1`).length;
      if (!okMember) return json({ error: "no-such-member" }, { status: 404 });
      const at = paid ? new Date().toISOString() : null;
      await sql(env)`
        INSERT INTO pot_entries (season, member_id, paid, paid_at)
        VALUES (${season}, ${targetId}, ${paid}, ${at})
        ON CONFLICT (season, member_id) DO UPDATE SET paid = ${paid}, paid_at = ${at}`;
      return json({ ok: true, member_id: targetId, paid });
    }

    if (action === "config") {
      if (!isCollector && !unset) {
        return json({ error: "forbidden", detail: "only the pot collector can change the settings" }, { status: 403 });
      }
      let entry = cfg.entry_amount;
      if (body.entry_amount !== undefined) {
        entry = Number(body.entry_amount);
        if (!(entry >= 0 && entry <= 100000)) return json({ error: "bad-entry" }, { status: 400 });
      }
      let collectorId = cfg.collector_id;
      if (body.collector_id !== undefined) {
        collectorId = body.collector_id == null ? null : Number(body.collector_id);
        if (collectorId != null && !(await sql(env)`SELECT 1 FROM members WHERE id = ${collectorId} LIMIT 1`).length) {
          return json({ error: "bad-collector" }, { status: 400 });
        }
      }
      let deadline = cfg.deadline;
      if (body.deadline !== undefined) {
        if (!body.deadline) deadline = null;
        else {
          const d = new Date(body.deadline);
          if (isNaN(d.getTime())) return json({ error: "bad-deadline" }, { status: 400 });
          deadline = d.toISOString();
        }
      }
      let payout = cfg.payout;
      if (Array.isArray(body.payout)) {
        payout = body.payout
          .map((p) => ({ place: Number(p.place), amount: Number(p.amount) }))
          .filter((p) => Number.isFinite(p.place) && p.place > 0 && Number.isFinite(p.amount) && p.amount >= 0)
          .sort((a, b) => a.place - b.place);
      }
      await sql(env)`
        INSERT INTO pot_config (season, entry_amount, collector_id, deadline, payout)
        VALUES (${season}, ${entry}, ${collectorId}, ${deadline}, ${JSON.stringify(payout)}::jsonb)
        ON CONFLICT (season) DO UPDATE SET
          entry_amount = ${entry}, collector_id = ${collectorId},
          deadline = ${deadline}, payout = ${JSON.stringify(payout)}::jsonb`;
      return json({ ok: true });
    }

    return json({ error: "unknown-action" }, { status: 400 });
  }

  if (request.method === "GET") {
    const season = seasonOf(env, url, null);
    const cfg = await loadConfig(env, season);
    const [members, entries] = await Promise.all([
      sql(env)`SELECT id, name, venmo_handle FROM members ORDER BY name`,
      sql(env)`SELECT member_id, paid, paid_at FROM pot_entries WHERE season = ${season}`,
    ]);
    const paidBy = Object.fromEntries(entries.map((e) => [e.member_id, e]));
    const collector = cfg.collector_id ? members.find((m) => m.id === cfg.collector_id) : null;
    const roster = members.map((m) => ({
      id: m.id,
      name: m.name,
      venmo_handle: m.venmo_handle || null,
      paid: !!paidBy[m.id]?.paid,
      paid_at: paidBy[m.id]?.paid_at || null,
      is_collector: m.id === cfg.collector_id,
    }));
    const paidCount = roster.filter((r) => r.paid).length;
    const potTotal = cfg.entry_amount * members.length;
    const collected = cfg.entry_amount * paidCount;
    return json({
      season,
      config: {
        entry_amount: cfg.entry_amount,
        collector_id: cfg.collector_id,
        collector_name: collector?.name || null,
        collector_venmo: collector?.venmo_handle || null,
        deadline: cfg.deadline,
        payout: cfg.payout,
        configured: cfg.configured,
      },
      me: { id: memberId, is_collector: cfg.collector_id === memberId },
      roster,
      progress: {
        paid_count: paidCount,
        member_count: members.length,
        collected,
        pot_total: potTotal,
      },
    });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
