// /api/picks  GET (read) / POST (submit) / POST ?action=mark-super-lock
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { pickCutoff, BET_TYPES, seasonTypeFor } from "../_shared/nfl.js";
import { fetchScoreboard, sameTeam } from "../_shared/grader.js";
import { ensureExtras } from "../_shared/migrations.js";

// ESPN scoreboard, cached briefly per warm isolate — used to reject picks on
// games that have already kicked off.
const SB_TTL_MS = 60 * 1000;
const sbCache = new Map(); // "season:week:seasontype" -> { ts, events }
async function scoreboardFor(season, week, seasontype = 2) {
  const key = `${season}:${week}:${seasontype}`;
  const hit = sbCache.get(key);
  if (hit && Date.now() - hit.ts < SB_TTL_MS) return hit.events;
  try {
    const events = await fetchScoreboard(season, week, seasontype);
    sbCache.set(key, { ts: Date.now(), events });
    return events;
  } catch {
    return hit ? hit.events : []; // fail open — the weekly cutoff still applies
  }
}

// The four auto-gradable bets are board-only: each must reference a real game
// and the side its bet type implies, so a hand-typed line that doesn't exist
// can never be stored. Super Lock (player props) stays free-text by nature.
const SIDE_FOR = { Favorite: "fav", Dog: "dog", Over: "over", Under: "under" };

// Same-origin read of the live board so the server can validate lines against
// exactly what the pick UI is showing. Reuses /api/odds' multi-source cache, so
// it's a cheap warm-cache hit in practice. Fails soft (null) if odds are down.
async function fetchLiveOdds(request) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(new URL("/api/odds", request.url), { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.games) ? j.games : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findGame(games, gameKey) {
  if (!gameKey) return null;
  const [a, h] = String(gameKey).split("@");
  return games.find((g) => sameTeam(g.away, a) && sameTeam(g.home, h)) || null;
}

// Choose the book to price a pick against: the one the picker tapped if it still
// offers the market, else the first book that does (FD, then DK, then any).
function pickBookFor(game, side, preferred) {
  const books = game.books || {};
  const offers = (b) => !!b && (side === "fav" || side === "dog" ? !!b.spread : !!b.total);
  if (preferred && offers(books[preferred])) return { book: preferred, data: books[preferred] };
  for (const key of ["fanduel", "draftkings", ...Object.keys(books)]) {
    if (offers(books[key])) return { book: key, data: books[key] };
  }
  return null;
}

// Re-derive a gradable pick's line, price, book, and canonical pick_text from
// the live board. Returns null if the chosen market isn't offered right now.
function deriveGradable(game, betType, side, preferredBook) {
  const chosen = pickBookFor(game, side, preferredBook);
  if (!chosen) return null;
  const { book, data } = chosen;
  if (betType === "Favorite" || betType === "Dog") {
    const s = data.spread;
    if (side === "fav") {
      return { line: s.line, price: s.favPrice ?? null, book, pick_text: `${s.fav} ${s.line}` };
    }
    const dog = s.fav === game.home ? game.away : game.home;
    return { line: s.line, price: s.dogPrice ?? null, book, pick_text: `${dog} +${Math.abs(s.line)}` };
  }
  const t = data.total;
  const tag = side === "over" ? "O" : "U";
  const price = side === "over" ? (t.overPrice ?? null) : (t.underPrice ?? null);
  return { line: t.point, price, book, pick_text: `${game.away} / ${game.home} ${tag}${t.point}` };
}

// Returns the offending pick if any submitted game has already started.
async function findStartedGame(picks, season, week, seasontype = 2) {
  const keyed = picks.filter(p => p.game_key);
  if (!keyed.length) return null;
  const events = await scoreboardFor(season, week, seasontype);
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

  // Remove a single pick (unpick from the board). Allowed until the weekly
  // cutoff, same as adding — a started-game pick can't reach here because its
  // board button renders locked (no data-bet to click).
  if (request.method === "POST" && action === "remove") {
    const memberId = await verifyCookie(env, request.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const { season, week, bet_type } = body;
    if (!season || !week || !BET_TYPES.includes(bet_type)) {
      return json({ error: "bad-body", expected: "{season, week, bet_type}" }, { status: 400 });
    }
    const cutoff = pickCutoff(season, week, env);
    if (Date.now() > cutoff.getTime()) {
      return json({ error: "locked", cutoff: cutoff.toISOString() }, { status: 423 });
    }
    const rows = await sql(env)`
      DELETE FROM picks
      WHERE member_id = ${memberId} AND season = ${season} AND week = ${week} AND bet_type = ${bet_type}
      RETURNING id`;
    return json({ ok: true, removed: rows.length });
  }

  if (request.method === "GET") {
    const season = Number(url.searchParams.get("season"));
    const week = url.searchParams.get("week") ? Number(url.searchParams.get("week")) : null;
    if (!season) return json({ error: "season-required" }, { status: 400 });
    let rows = week
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
    // Live seasons: other members' picks stay hidden until the week locks,
    // so nobody can scout picks before the Sunday cutoff.
    if (season >= 2026) {
      const viewer = await verifyCookie(env, request.headers.get("cookie"));
      const now = Date.now();
      rows = rows.filter(p => p.member_id === viewer || now >= pickCutoff(season, p.week, env).getTime());
    }
    // Week view also reports who has submitted (count only, never contents),
    // so the group can see who still owes picks before the cutoff.
    if (week) {
      const submitted = await sql(env)`
        SELECT m.id AS member_id, m.name, COUNT(p.id)::int AS picks
        FROM members m
        LEFT JOIN picks p ON p.member_id = m.id AND p.season = ${season} AND p.week = ${week}
        GROUP BY m.id, m.name
        ORDER BY m.name`;
      return json({ picks: rows, submitted });
    }
    return json({ picks: rows });
  }

  if (request.method === "POST") {
    const memberId = await verifyCookie(env, request.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const { season, week, picks } = body;
    if (!season || !week || !Array.isArray(picks)) return json({ error: "bad-body" }, { status: 400 });

    const cutoff = pickCutoff(season, week, env);
    if (Date.now() > cutoff.getTime()) {
      return json({ error: "locked", cutoff: cutoff.toISOString() }, { status: 423 });
    }
    // Shape check. Super Lock is free-text (honor system on price); the four
    // gradable bets must carry the game + the side their bet type implies.
    for (const p of picks) {
      if (!BET_TYPES.includes(p.bet_type)) return json({ error: "bad-bet-type", bet_type: p.bet_type }, { status: 400 });
      if (p.bet_type === "Super Lock") {
        if (!p.pick_text || typeof p.pick_text !== "string") return json({ error: "missing-pick-text", bet_type: p.bet_type }, { status: 400 });
        if (p.price != null && !(Number(p.price) <= -120)) {
          return json({ error: "super-lock-price", detail: "Super Lock must be -120 or harder", price: p.price }, { status: 400 });
        }
      } else {
        if (SIDE_FOR[p.bet_type] !== p.side) return json({ error: "bad-side", bet_type: p.bet_type, side: p.side, expected: SIDE_FOR[p.bet_type] }, { status: 400 });
        if (!p.game_key || typeof p.game_key !== "string") return json({ error: "missing-game", bet_type: p.bet_type }, { status: 400 });
      }
    }
    // Authoritative line check: re-derive every gradable pick's line/price/book/
    // text from the current live board, so a stored pick can never claim a line
    // the book isn't actually offering (closes the old free-text hole). If odds
    // are momentarily unavailable, degrade to requiring a well-formed structured
    // line — never a free-typed string.
    const gradable = picks.filter((p) => p.bet_type !== "Super Lock");
    if (gradable.length) {
      const games = await fetchLiveOdds(request);
      for (const p of gradable) {
        if (games) {
          const g = findGame(games, p.game_key);
          if (!g) return json({ error: "game-not-on-board", game_key: p.game_key, bet_type: p.bet_type }, { status: 422 });
          const d = deriveGradable(g, p.bet_type, p.side, p.book);
          if (!d) return json({ error: "line-not-offered", game_key: p.game_key, bet_type: p.bet_type }, { status: 422 });
          p.line = d.line; p.price = d.price; p.book = d.book; p.pick_text = d.pick_text;
        } else {
          if (!Number.isFinite(Number(p.line))) return json({ error: "missing-line", bet_type: p.bet_type }, { status: 400 });
          if (!p.pick_text || typeof p.pick_text !== "string") return json({ error: "missing-pick-text", bet_type: p.bet_type }, { status: 400 });
        }
      }
    }
    // A game that has kicked off can no longer be picked (TNF after kickoff,
    // international games that start before the Sunday noon cutoff, ...).
    const started = await findStartedGame(picks, season, week, seasonTypeFor(env));
    if (started) {
      return json({ error: "game-started", ...started }, { status: 423 });
    }
    const lockedAt = new Date().toISOString();
    await ensureExtras(env); // alert_line column used below
    const s = sql(env);
    // Distinct bet_types per member → upserts are independent; run in parallel.
    // Re-locking clears alert_line so line-move alerts restart from the new line.
    await Promise.all(picks.map(p => s`
        INSERT INTO picks (member_id, season, week, bet_type, pick_text, game_key, side, line, book, price, locked_at, alert_line)
        VALUES (${memberId}, ${season}, ${week}, ${p.bet_type}, ${p.pick_text},
                ${p.game_key || null}, ${p.side || null}, ${p.line ?? null},
                ${p.book || null}, ${p.price ?? null}, ${lockedAt}, NULL)
        ON CONFLICT (member_id, season, week, bet_type)
        DO UPDATE SET
          pick_text  = EXCLUDED.pick_text,
          game_key   = EXCLUDED.game_key,
          side       = EXCLUDED.side,
          line       = EXCLUDED.line,
          book       = EXCLUDED.book,
          price      = EXCLUDED.price,
          locked_at  = EXCLUDED.locked_at,
          alert_line = NULL`));
    return json({ ok: true, count: picks.length });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
