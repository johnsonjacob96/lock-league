// /api/picks  GET (read) / POST (submit)
import { sql } from "../../lib/db.js";
import { verifyCookie } from "./auth.mjs";
import { pickCutoff, BET_TYPES } from "../../lib/nfl.js";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const season = Number(url.searchParams.get("season"));
    const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
    if (!season) return json({ error: "season-required" }, { status: 400 });
    const rows = week
      ? await sql()`
          SELECT p.*, m.name AS member_name
          FROM picks p JOIN members m ON m.id = p.member_id
          WHERE p.season = ${season} AND p.week = ${week}
          ORDER BY m.name, p.bet_type`
      : await sql()`
          SELECT p.*, m.name AS member_name
          FROM picks p JOIN members m ON m.id = p.member_id
          WHERE p.season = ${season}
          ORDER BY p.week, m.name, p.bet_type`;
    return json({ picks: rows });
  }

  if (req.method === "POST") {
    const memberId = verifyCookie(req.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
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
    for (const p of picks) {
      await sql()`
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
};
