// /api/picks
//   GET  /api/picks?season=2026&week=3            → returns picks for that week, all members
//   GET  /api/picks?season=2026                   → all picks for the season (standings)
//   POST /api/picks   { season, week, picks: [{bet_type, pick_text, game_key, side, line, book, price}] }
//                                                   submit your own picks for the current week
//
// Auth required for POST; identifies the member via cookie.
// Past-the-cutoff submissions return 423 Locked.

import { sql } from "../lib/db.js";
import { verifyCookie } from "./auth.js";
import { pickCutoff, BET_TYPES } from "../lib/nfl.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try { resolve(JSON.parse(chunks || "{}")); } catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const season = Number(req.query.season);
    const week = req.query.week ? Number(req.query.week) : null;
    if (!season) return res.status(400).json({ error: "season-required" });
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
    return res.status(200).json({ picks: rows });
  }

  if (req.method === "POST") {
    const memberId = verifyCookie(req.headers.cookie);
    if (!memberId) return res.status(401).json({ error: "not-authenticated" });
    const body = await readBody(req);
    const { season, week, picks } = body;
    if (!season || !week || !Array.isArray(picks)) {
      return res.status(400).json({ error: "bad-body" });
    }
    // Cutoff check
    const cutoff = pickCutoff(season, week);
    if (Date.now() > cutoff.getTime()) {
      return res.status(423).json({ error: "locked", cutoff: cutoff.toISOString() });
    }
    // Validate bet types
    for (const p of picks) {
      if (!BET_TYPES.includes(p.bet_type)) {
        return res.status(400).json({ error: "bad-bet-type", bet_type: p.bet_type });
      }
      if (!p.pick_text || typeof p.pick_text !== "string") {
        return res.status(400).json({ error: "missing-pick-text", bet_type: p.bet_type });
      }
    }
    // Upsert each pick
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
    return res.status(200).json({ ok: true, count: picks.length });
  }

  return res.status(405).json({ error: "method-not-allowed" });
}
