// /api/picks  GET (read) / POST (submit)
import { sql } from "../../lib/db.js";
import { verifyCookie } from "./auth.mjs";
import { pickCutoff, BET_TYPES } from "../../lib/nfl.js";
import { fetchScoreboard, sameTeam } from "../../lib/grader.js";

// ESPN scoreboard, cached briefly per warm container — used to reject picks
// on games that have already kicked off.
const SB_TTL_MS = 60 * 1000;
const sbCache = new Map(); // "season:week" -> { ts, events }
async function scoreboardFor(season, week) {
  const key = `${season}:${week}`;
  const hit = sbCache.get(key);
  if (hit && Date.now() - hit.ts < SB_TTL_MS) return hit.events;
  try {
    const events = await fetchScoreboard(season, week);
    sbCache.set(key, { ts: Date.now(), events });
    return events;
  } catch {
    return hit ? hit.events : []; // fail open — the weekly cutoff still applies
  }
}

// Returns the offending pick if any submitted game has already started.
async function findStartedGame(picks, season, week) {
  const keyed = picks.filter(p => p.game_key);
  if (!keyed.length) return null;
  const events = await scoreboardFor(season, week);
  const now = Date.now();
  for (const p of keyed) {
    const [away, home] = String(p.game_key).split("@");
    const ev = events.find(e => sameTeam(e.away, away) && sameTeam(e.home, home));
    if (ev?.kickoff && new Date(ev.kickoff).getTime() <= now) {
      return { game_key: p.game_key, kickoff: ev.kickoff };
    }
  }
  return null;
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  // Self-mark Super Lock result — auth required
  if (req.method === "POST" && action === "mark-super-lock") {
    const memberId = verifyCookie(req.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const { season, week, result } = body;
    if (!season || !week || !["W", "L", "P"].includes(result)) {
      return json({ error: "bad-body", expected: "{season, week, result: W|L|P}" }, { status: 400 });
    }
    const rows = await sql()`
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

  if (req.method === "GET") {
    const season = Number(url.searchParams.get("season"));
    const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
    if (!season) return json({ error: "season-required" }, { status: 400 });
    let rows = week
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
    // Live seasons: other members' picks stay hidden until the week locks,
    // so nobody can scout picks before the Sunday cutoff.
    if (season >= 2026) {
      const viewer = verifyCookie(req.headers.get("cookie"));
      const now = Date.now();
      rows = rows.filter(p => p.member_id === viewer || now >= pickCutoff(season, p.week).getTime());
    }
    // Week view also reports who has submitted (count only, never contents),
    // so the group can see who still owes picks before the cutoff.
    if (week) {
      const submitted = await sql()`
        SELECT m.id AS member_id, m.name, COUNT(p.id)::int AS picks
        FROM members m
        LEFT JOIN picks p ON p.member_id = m.id AND p.season = ${season} AND p.week = ${week}
        GROUP BY m.id, m.name
        ORDER BY m.name`;
      return json({ picks: rows, submitted });
    }
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
      // League rule: Super Lock must be -120 or harder (enforced when a
      // structured price is provided; free-text stays on the honor system).
      if (p.bet_type === "Super Lock" && p.price != null && !(Number(p.price) <= -120)) {
        return json({ error: "super-lock-price", detail: "Super Lock must be -120 or harder", price: p.price }, { status: 400 });
      }
    }
    // A game that has kicked off can no longer be picked (TNF after kickoff,
    // international games that start before the Sunday noon cutoff, ...).
    const started = await findStartedGame(picks, season, week);
    if (started) {
      return json({ error: "game-started", ...started }, { status: 423 });
    }
    const lockedAt = new Date().toISOString();
    const s = sql();
    // Distinct bet_types per member → upserts are independent; run in parallel.
    await Promise.all(picks.map(p => s`
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
          locked_at = EXCLUDED.locked_at`));
    return json({ ok: true, count: picks.length });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
};
