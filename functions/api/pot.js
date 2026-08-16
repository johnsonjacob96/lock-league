// /api/pot — league money dashboard. Two flows, NEITHER custodied by the app:
//
//  1. Season pot (Article 11: $100 entry, $500/$200/$100) — held + paid out by
//     LeagueSafe. The app just links to the league (`leaguesafe_url`) and shows
//     the entry + payout for reference. No in-app payment tracking; LeagueSafe
//     owns that (it carries the money-transmitter licensing to custody a pot).
//
//  2. Weekly game — runs on Venmo, PRE-FUNDED. Every member sends the collector
//     (Jared) a season buy-in (`weekly_buyin`, default $90) at the start of the
//     year; the collector banks it and Venmos each week's winner the weekly prize
//     (`weekly_prize`, default $40, paid via /api/settlement). This endpoint
//     tracks who has paid the buy-in and gives a one-tap Venmo link to the
//     collector. The app never holds the money — it moves P2P to the collector.
//
//   GET  ?season=          -> season-pot info + weekly-fund config, roster, progress
//   POST ?action=set-paid  -> mark a member's buy-in paid/unpaid (self, or collector)
//   POST ?action=config    -> set url/amounts/collector/deadline (collector; or anyone if unset)
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek } from "../_shared/nfl.js";
import { ensureExtras } from "../_shared/migrations.js";

const DEFAULT_ENTRY = 100;
const DEFAULT_BUYIN = 90;
const DEFAULT_PRIZE = 40;
const DEFAULT_PAYOUT = [
  { place: 1, amount: 500 },
  { place: 2, amount: 200 },
  { place: 3, amount: 100 },
];

// The UTC instant that reads as 23:59:59 America/Chicago on the given
// YYYY-MM-DD. Standard "guess, observe the offset, correct" technique so it's
// right on both sides of the CDT/CST boundary without a timezone library.
function centralEndOfDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(guess).reduce((o, p) => (o[p.type] = p.value, o), {});
  const renderedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return new Date(guess.getTime() + (guess.getTime() - renderedAsUtc));
}

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
    SELECT season, entry_amount, collector_id, deadline, payout, leaguesafe_url, weekly_buyin, weekly_prize
    FROM pot_config WHERE season = ${season} LIMIT 1`)[0];
  return {
    entry_amount: row?.entry_amount != null ? Number(row.entry_amount) : DEFAULT_ENTRY,
    collector_id: row?.collector_id ?? null,
    deadline: row?.deadline ?? null,
    payout: Array.isArray(row?.payout) ? row.payout : DEFAULT_PAYOUT,
    leaguesafe_url: row?.leaguesafe_url ?? null,
    weekly_buyin: row?.weekly_buyin != null ? Number(row.weekly_buyin) : DEFAULT_BUYIN,
    weekly_prize: row?.weekly_prize != null ? Number(row.weekly_prize) : DEFAULT_PRIZE,
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
      // A member can always flip their OWN buy-in; the collector flips anyone's.
      if (memberId !== targetId && !isCollector) {
        return json({ error: "forbidden", detail: "only you or the pot collector can change this" }, { status: 403 });
      }
      if (!(await sql(env)`SELECT 1 FROM members WHERE id = ${targetId} LIMIT 1`).length) {
        return json({ error: "no-such-member" }, { status: 404 });
      }
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
      const num = (v, cur) => {
        if (v === undefined) return cur;
        const n = Number(v);
        return n >= 0 && n <= 1000000 ? n : cur;
      };
      const entry = num(body.entry_amount, cfg.entry_amount);
      const buyin = num(body.weekly_buyin, cfg.weekly_buyin);
      const prize = num(body.weekly_prize, cfg.weekly_prize);
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
          // A bare YYYY-MM-DD (an <input type="date"> value) parses as UTC
          // midnight, which reads as the PREVIOUS day once displayed/compared
          // in Central and flips "past due" up to a day early. Treat it as
          // end-of-day Central instead of literal UTC midnight.
          const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(body.deadline).trim());
          const d = dateOnly ? centralEndOfDay(String(body.deadline).trim()) : new Date(body.deadline);
          if (isNaN(d.getTime())) return json({ error: "bad-deadline" }, { status: 400 });
          deadline = d.toISOString();
        }
      }
      let leaguesafeUrl = cfg.leaguesafe_url;
      if (body.leaguesafe_url !== undefined) {
        const u = String(body.leaguesafe_url || "").trim();
        if (!u) leaguesafeUrl = null;
        else if (/^https?:\/\/[^\s]+$/i.test(u)) leaguesafeUrl = u;
        else return json({ error: "bad-url", detail: "must start with http(s)://" }, { status: 400 });
      }
      let payout = cfg.payout;
      if (Array.isArray(body.payout)) {
        payout = body.payout
          .map((p) => ({ place: Number(p.place), amount: Number(p.amount) }))
          .filter((p) => Number.isFinite(p.place) && p.place > 0 && Number.isFinite(p.amount) && p.amount >= 0)
          .sort((a, b) => a.place - b.place);
      }
      await sql(env)`
        INSERT INTO pot_config (season, entry_amount, collector_id, deadline, payout, leaguesafe_url, weekly_buyin, weekly_prize)
        VALUES (${season}, ${entry}, ${collectorId}, ${deadline}, ${JSON.stringify(payout)}::jsonb, ${leaguesafeUrl}, ${buyin}, ${prize})
        ON CONFLICT (season) DO UPDATE SET
          entry_amount = ${entry}, collector_id = ${collectorId}, deadline = ${deadline},
          payout = ${JSON.stringify(payout)}::jsonb, leaguesafe_url = ${leaguesafeUrl},
          weekly_buyin = ${buyin}, weekly_prize = ${prize}`;
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
      paid: !!paidBy[m.id]?.paid,
      paid_at: paidBy[m.id]?.paid_at || null,
      is_collector: m.id === cfg.collector_id,
    }));
    const paidCount = roster.filter((r) => r.paid).length;
    const me = roster.find((r) => r.id === memberId);
    return json({
      season,
      season_pot: {
        entry_amount: cfg.entry_amount,
        payout: cfg.payout,
        leaguesafe_url: cfg.leaguesafe_url,
        pot_total: cfg.entry_amount * members.length,
      },
      weekly: {
        buyin: cfg.weekly_buyin,
        prize: cfg.weekly_prize,
        deadline: cfg.deadline,
        collector: collector
          ? { id: collector.id, name: collector.name, venmo_handle: collector.venmo_handle || null }
          : null,
        roster,
        progress: {
          paid_count: paidCount,
          member_count: members.length,
          collected: cfg.weekly_buyin * paidCount,
          total: cfg.weekly_buyin * members.length,
        },
        me: { id: memberId, is_collector: cfg.collector_id === memberId, paid: !!me?.paid },
      },
      can_configure: cfg.collector_id === memberId || cfg.collector_id == null,
    });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
