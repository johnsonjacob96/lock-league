// /api/picks  GET (read) / POST (submit) / POST ?action=mark-super-lock
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { pickCutoff, BET_TYPES } from "../_shared/nfl.js";

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (request.method === "POST" && action === "mark-super-lock") {
    const memberId = await verifyCookie(env, request.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const { season, week, result } = body;
    if (!season || !week || !["W", "L", "P"].includes(result)) {
      return json({ error: "bad-body", expected: "{season, week, result: W|L|P}" }, { status: 400 });
    }
    const rows = await sql(env)`
      UPDATE picks
      SET result = ${result}, graded_at = NOW()
      WHERE member_id = ${memberId}
        AND season = ${season}
        AND week = ${week}
        AND bet_type = 'Super Lock'
      RETURNING id`;
    if (!rows.length) return json({ error: "no-such-pick" }, { status: 404 });
    return json({ ok: true, id: rows[0].id, result });
  }

  if (request.method === "GET") {
    const season = Number(url.searchParams.get("season"));
    const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
    if (!season) return json({ error: "season-required" }, { status: 400 });
    const rows = week
      ? await sql(env)`
          SELECT p.*, m.name AS member_name
          FROM picks p JOIN members m ON m.id = p.member_id
          WHERE p.season = ${season} AND p.week = ${week}
          ORDER BY m.name, p.bet_type`
      : await sql(env)`
          SELECT p.*, m.name AS member_name
          FROM picks p JOIN members m ON m.id = p.member_id
          WHERE p.season = ${season}
          ORDER BY p.week, m.name, p.bet_type`;
    return json({ picks: rows });
  }

  if (request.method === "POST") {
    const memberId = await verifyCookie(env, request.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const { season, week, picks } = body;
    if (!season || !week || !Array.isArray(picks)) return json({ error: "bad-body" }, { status: 400 });

    const cutoff = pickCutoff(season, week);
    if (Date.now() > cutoff.getTime()) {
      return json({ error: "locked", cutoff: cutoff.toISOString() }, { status: 423 });
    }
    for (const p of picks) {
      if (!BET_TYPES.includes(p.bet_type)) return json({ error: "bad-bet-type", bet_type: p.bet_type }, { status: 400 });
      if (!p.pick_text || typeof p.pick_text !== "string") return json({ error: "missing-pick-text", bet_type: p.bet_type }, { status: 400 });
    }
    const lockedAt = new Date().toISOString();
    const s = sql(env);
    for (const p of picks) {
      await s`
        INSERT INTO picks (member_id, season, week, bet_type, pick_text, game_key, side, line, book, price, locked_at)
        VALUES (${memberId}, ${season}, ${week}, ${p.bet_type}, ${p.pick_text},
                ${p.game_key || null}, ${p.side || null}, ${p.line ?? null},
                ${p.book || null}, ${p.price ?? null}, ${lockedAt})
        ON CONFLICT (member_id, season, week, bet_type)
        DO UPDATE SET
          pick_text = EXCLUDED.pick_text,
          game_key  = EXCLUDED.game_key,
          side      = EXCLUDED.side,
          line      = EXCLUDED.line,
          book      = EXCLUDED.book,
          price     = EXCLUDED.price,
          locked_at = EXCLUDED.locked_at`;
    }
    return json({ ok: true, count: picks.length });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
