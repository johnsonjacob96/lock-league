// /api/picks  GET (read) / POST (submit) / POST ?action=mark-super-lock
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { pickCutoff, BET_TYPES, seasonTypeFor } from "../_shared/nfl.js";
import { fetchScoreboard, sameTeam } from "../_shared/grader.js";
import { ensureExtras } from "../_shared/migrations.js";
import { PROP_DEFS, propPickText, samePlayer } from "../_shared/props.js";

// ESPN scoreboard, cached briefly per warm isolate — used to reject picks on
// games that have already kicked off.
const SB_TTL_MS = 60 * 1000;
const sbCache = new Map(); // "season:week:seasontype" -> { ts, events }
async function scoreboardFor(season, week, seasontype = 2, env = null) {
  const key = `${season}:${week}:${seasontype}`;
  const hit = sbCache.get(key);
  if (hit && Date.now() - hit.ts < SB_TTL_MS) return hit.events;
  try {
    const events = await fetchScoreboard(season, week, seasontype, env);
    sbCache.set(key, { ts: Date.now(), events });
    return events;
  } catch (e) {
    if (hit) return hit.events; // serve the last-known board through a blip
    // No board at all to check against. findStartedGame/findMondayGame exist
    // specifically to catch an already-kicked-off or MNF game before the
    // weekly cutoff — silently returning [] here would disable both guards
    // instead of protecting them, so the caller must fail closed.
    throw e;
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

// Same-origin read of the live prop board for one game, so a structured Super
// Lock is validated against exactly what the picker showed. Reuses /api/props'
// cache. Fails soft (null) if props are down / not posted yet.
async function fetchLiveProps(request, gameKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const u = new URL("/api/props", request.url);
    u.searchParams.set("game_key", gameKey);
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.markets) ? j.markets : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Re-derive a structured Super Lock's line/price/book/canonical text from the
// live prop menu, so a stored prop can never claim a line the book isn't
// offering. Returns null if that player+market isn't on the board.
export function deriveProp(markets, prop) { // exported for tests; CF ignores non-handler exports
  const m = markets.find((x) => x.market === prop.market);
  if (!m) return null;
  const pl = m.players.find((x) => samePlayer(x.player, prop.player));
  if (!pl) return null;
  const book = prop.book && pl[prop.book] ? prop.book : (pl.fanduel ? "fanduel" : (pl.draftkings ? "draftkings" : null));
  const bk = book ? pl[book] : null;
  if (m.kind === "yes") {
    const price = bk ? (bk.yes ?? null) : null;
    return { market: prop.market, player: pl.player, line: null, side: "yes", price, book, pick_text: propPickText({ market: prop.market, player: pl.player, side: "yes" }) };
  }
  const side = prop.side === "under" ? "under" : "over";
  // Use the priced book's own line (books can hang different numbers), falling
  // back to the aggregate line only if that book didn't post one.
  const line = (bk && bk.line != null) ? bk.line : pl.line;
  const price = bk ? (side === "under" ? (bk.under ?? null) : (bk.over ?? null)) : null;
  return { market: prop.market, player: pl.player, line, side, price, book, pick_text: propPickText({ market: prop.market, player: pl.player, line, side }) };
}

// Returns the offending pick if any submitted game has already started.
async function findStartedGame(picks, season, week, seasontype = 2, env = null) {
  const keyed = picks.filter(p => p.game_key);
  if (!keyed.length) return null;
  const events = await scoreboardFor(season, week, seasontype, env);
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

// Returns the offending pick if any submitted game is a Monday (MNF) game — those
// aren't allowed in this league. Weekday is read in Central (an MNF kickoff falls
// on Tuesday in UTC, so a naive UTC check would miss it). The board never offers
// them, so this is a backstop against a hand-crafted request. Uses the cached
// scoreboard (shared with findStartedGame within the request).
async function findMondayGame(picks, season, week, seasontype = 2, env = null) {
  const keyed = picks.filter(p => p.game_key);
  if (!keyed.length) return null;
  const events = await scoreboardFor(season, week, seasontype, env);
  for (const p of keyed) {
    const [away, home] = String(p.game_key).split("@");
    const ev = events.find(e => sameTeam(e.away, away) && sameTeam(e.home, home));
    const day = ev?.kickoff && new Date(ev.kickoff).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Chicago" });
    if (day === "Mon") return { game_key: p.game_key, kickoff: ev.kickoff };
  }
  return null;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  // Cron/admin: wipe the preseason-test data (season 2026, week 2) after the
  // dry run, so the test picks don't pollute the real regular-season week 2.
  // Also clears the seeded preseason board so it flips to the live Week 1 board.
  if (request.method === "POST" && action === "wipe-test") {
    if (!env.CRON_SECRET || request.headers.get("X-Cron-Secret") !== env.CRON_SECRET) {
      return json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const s = sql(env);
    const out = {};
    const run = async (label, fn) => { try { const r = await fn(); out[label] = Array.isArray(r) ? r.length : (r ?? true); } catch (e) { out[label] = "skip:" + String(e && e.message || e).slice(0, 40); } };
    await run("picks", () => s`DELETE FROM picks WHERE season = 2026 AND week = 2 RETURNING id`);
    await run("weekly_dues", () => s`DELETE FROM weekly_dues WHERE season = 2026 AND week = 2 RETURNING member_id`);
    await run("week_notifications", () => s`DELETE FROM week_notifications WHERE season = 2026 AND week = 2 RETURNING season`);
    await run("scoreboard_snapshot", () => s`DELETE FROM scoreboard_snapshot WHERE season = 2026 AND week = 2 RETURNING season`);
    await run("odds_snapshot", () => s`DELETE FROM odds_snapshot WHERE id = 1 RETURNING id`);
    return json({ ok: true, deleted: out }, { headers: { "Cache-Control": "no-store" } });
  }

  if (request.method === "POST" && action === "mark-super-lock") {
    const memberId = await verifyCookie(env, request.headers.get("cookie"));
    if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const { season, week, result } = body;
    if (!season || !week || !["W", "L", "P"].includes(result)) {
      return json({ error: "bad-body", expected: "{season, week, result: W|L|P}" }, { status: 400 });
    }
    // Only a free-text Super Lock (prop_meta IS NULL) is manually gradable —
    // a structured one (a live-board player prop or game-line pick) is owned
    // by the auto-grader, so this can never overwrite its graded result.
    const rows = await sql(env)`
      UPDATE picks
      SET result = ${result}, graded_at = NOW()
      WHERE member_id = ${memberId}
        AND season = ${season}
        AND week = ${week}
        AND bet_type = 'Super Lock'
        AND prop_meta IS NULL
      RETURNING id`;
    if (!rows.length) return json({ error: "no-such-pick" }, { status: 404 });
    return json({ ok: true, id: rows[0].id, result });
  }

  // Remove a single pick (unpick from the board). Allowed until the weekly
  // cutoff, same as adding — the board's own button renders locked once its
  // game starts, but the API is the actual boundary, so it re-checks the
  // same per-game start guard `submit` enforces (otherwise a member could
  // unpick a losing bet on an already-live game and re-pick a later one).
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
    const existing = (await sql(env)`
      SELECT game_key FROM picks
      WHERE member_id = ${memberId} AND season = ${season} AND week = ${week} AND bet_type = ${bet_type}`)[0];
    if (existing?.game_key) {
      let started;
      try {
        started = await findStartedGame([{ game_key: existing.game_key }], season, week, seasonTypeFor(env), env);
      } catch {
        return json({ error: "scoreboard-unavailable", detail: "Can't verify game time right now — try again shortly." }, { status: 503 });
      }
      if (started) return json({ error: "game-started", ...started }, { status: 423 });
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
    // Every bet_type upserts on (member, season, week, bet_type); two picks
    // sharing one in the same request would race as parallel ON CONFLICT
    // upserts on the same row further down.
    const seenTypes = new Set();
    for (const p of picks) {
      if (seenTypes.has(p.bet_type)) return json({ error: "duplicate-bet-type", bet_type: p.bet_type }, { status: 400 });
      seenTypes.add(p.bet_type);
    }

    const cutoff = pickCutoff(season, week, env);
    if (Date.now() > cutoff.getTime()) {
      return json({ error: "locked", cutoff: cutoff.toISOString() }, { status: 423 });
    }
    // Shape check. Super Lock is free-text (honor system on price); the four
    // gradable bets must carry the game + the side their bet type implies.
    for (const p of picks) {
      if (!BET_TYPES.includes(p.bet_type)) return json({ error: "bad-bet-type", bet_type: p.bet_type }, { status: 400 });
      if (p.bet_type === "Super Lock") {
        if (p.prop) {
          // Structured Super Lock (picked off the live prop board -> auto-grades).
          if (!PROP_DEFS[p.prop.market]) return json({ error: "bad-prop-market", market: p.prop.market }, { status: 400 });
          if (!p.prop.player || typeof p.prop.player !== "string") return json({ error: "missing-prop-player" }, { status: 400 });
          if (!p.prop.game_key || typeof p.prop.game_key !== "string") return json({ error: "missing-game", bet_type: p.bet_type }, { status: 400 });
          p.game_key = p.prop.game_key; // ties it to the game (started-game guard + auto-grade)
        } else if (p.line_pick) {
          // Game-line Super Lock: a spread/total off the live board (auto-grades
          // just like a Favorite/Dog/Over/Under, only filed under Super Lock).
          if (!SIDE_FOR[p.line_pick.bet]) return json({ error: "bad-line-bet", bet: p.line_pick.bet }, { status: 400 });
          if (SIDE_FOR[p.line_pick.bet] !== p.line_pick.side) return json({ error: "bad-side", bet_type: p.bet_type, side: p.line_pick.side, expected: SIDE_FOR[p.line_pick.bet] }, { status: 400 });
          if (!p.line_pick.game_key || typeof p.line_pick.game_key !== "string") return json({ error: "missing-game", bet_type: p.bet_type }, { status: 400 });
          p.game_key = p.line_pick.game_key; // ties it to the game (started-game guard + auto-grade)
        } else {
          // Free-text Super Lock (manual Hit/Miss/Push, honor system on price).
          if (!p.pick_text || typeof p.pick_text !== "string") return json({ error: "missing-pick-text", bet_type: p.bet_type }, { status: 400 });
          if (p.price != null && !(Number(p.price) >= -120)) {
            return json({ error: "super-lock-price", detail: "Super Lock odds must be -120 or longer (no shorter than -120); plus-money is fine", price: p.price }, { status: 400 });
          }
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
    // Structured Super Lock: re-derive line/price/book/text from the live prop
    // board, same anti-cheat treatment as the gradable bets. Enforce the league's
    // "-120 or longer" lock rule on the derived price (no shorter than -120;
    // plus-money allowed). If props are momentarily
    // down (or not posted yet), degrade to a well-formed structured prop.
    const structured = picks.filter((p) => p.bet_type === "Super Lock" && p.prop);
    for (const p of structured) {
      const markets = await fetchLiveProps(request, p.game_key);
      let d = markets ? deriveProp(markets, p.prop) : null;
      if (markets && !d) return json({ error: "prop-not-offered", game_key: p.game_key, market: p.prop.market, player: p.prop.player }, { status: 422 });
      if (!d) {
        // Degrade: trust the client's structured prop but require it be well-formed.
        const kind = PROP_DEFS[p.prop.market].kind;
        if (kind !== "yes" && !Number.isFinite(Number(p.prop.line))) return json({ error: "missing-line", bet_type: "Super Lock" }, { status: 400 });
        d = { market: p.prop.market, player: p.prop.player, line: p.prop.line ?? null,
              side: kind === "yes" ? "yes" : (p.prop.side === "under" ? "under" : "over"),
              price: p.prop.price ?? null, book: p.prop.book || null,
              pick_text: propPickText({ market: p.prop.market, player: p.prop.player, line: p.prop.line, side: p.prop.side }) };
      }
      if (d.price != null && !(Number(d.price) >= -120)) {
        return json({ error: "super-lock-price", detail: "Super Lock odds must be -120 or longer (no shorter than -120); plus-money is fine", price: d.price, player: d.player }, { status: 400 });
      }
      p.prop = { market: d.market, player: d.player, line: d.line, side: d.side, price: d.price, book: d.book, game_key: p.game_key };
      p.pick_text = d.pick_text; p.price = d.price; p.book = d.book;
    }
    // Game-line Super Lock: re-derive line/price/book/text from the live board
    // exactly like a gradable bet (same anti-cheat), enforce the -120 lock rule,
    // and stamp a prop_meta marker {kind, bet} so the grader scores it as a
    // spread/total instead of a player prop.
    const lineLocks = picks.filter((p) => p.bet_type === "Super Lock" && p.line_pick);
    if (lineLocks.length) {
      const games = await fetchLiveOdds(request);
      for (const p of lineLocks) {
        const lp = p.line_pick;
        if (games) {
          const g = findGame(games, lp.game_key);
          if (!g) return json({ error: "game-not-on-board", game_key: lp.game_key, bet_type: "Super Lock" }, { status: 422 });
          const d = deriveGradable(g, lp.bet, lp.side, lp.book);
          if (!d) return json({ error: "line-not-offered", game_key: lp.game_key, bet_type: "Super Lock" }, { status: 422 });
          p.line = d.line; p.price = d.price; p.book = d.book; p.pick_text = d.pick_text; p.side = lp.side;
        } else {
          // Degrade: trust the client's structured line but require it be well-formed.
          if (!Number.isFinite(Number(lp.line))) return json({ error: "missing-line", bet_type: "Super Lock" }, { status: 400 });
          if (!lp.pick_text || typeof lp.pick_text !== "string") return json({ error: "missing-pick-text", bet_type: "Super Lock" }, { status: 400 });
          p.line = Number(lp.line); p.side = lp.side; p.book = lp.book || null; p.price = lp.price ?? null; p.pick_text = lp.pick_text;
        }
        if (p.price != null && !(Number(p.price) >= -120)) {
          return json({ error: "super-lock-price", detail: "Super Lock odds must be -120 or longer (no shorter than -120); plus-money is fine", price: p.price }, { status: 400 });
        }
        p.prop = { kind: (lp.bet === "Over" || lp.bet === "Under") ? "total" : "spread", bet: lp.bet, side: p.side, line: p.line, book: p.book, price: p.price, game_key: p.game_key };
      }
    }
    // A game that has kicked off can no longer be picked (TNF after kickoff,
    // international games that start before the Sunday noon cutoff, ...), and
    // Monday (MNF) games can't be picked in this league. Both need a live
    // scoreboard to check against; if ESPN is down and there's no cached
    // board either, fail closed (503) instead of silently letting an
    // unverified pick through — these guards exist precisely to protect
    // against an already-started or ineligible game.
    let started, monday;
    try {
      started = await findStartedGame(picks, season, week, seasonTypeFor(env), env);
      monday = await findMondayGame(picks, season, week, seasonTypeFor(env), env);
    } catch {
      return json({ error: "scoreboard-unavailable", detail: "Can't verify game times right now — try again shortly." }, { status: 503 });
    }
    if (started) {
      return json({ error: "game-started", ...started }, { status: 423 });
    }
    if (monday) {
      return json({ error: "monday-not-allowed", ...monday }, { status: 422 });
    }
    const lockedAt = new Date().toISOString();
    await ensureExtras(env); // alert_line column used below
    const s = sql(env);
    // Distinct bet_types per member → upserts are independent; run in parallel.
    // Re-locking clears alert_line so line-move alerts restart from the new line.
    await Promise.all(picks.map(p => s`
        INSERT INTO picks (member_id, season, week, bet_type, pick_text, game_key, side, line, book, price, locked_at, alert_line, prop_meta)
        VALUES (${memberId}, ${season}, ${week}, ${p.bet_type}, ${p.pick_text},
                ${p.game_key || null}, ${p.side || null}, ${p.line ?? null},
                ${p.book || null}, ${p.price ?? null}, ${lockedAt}, NULL,
                ${p.prop ? JSON.stringify(p.prop) : null}::jsonb)
        ON CONFLICT (member_id, season, week, bet_type)
        DO UPDATE SET
          pick_text  = EXCLUDED.pick_text,
          game_key   = EXCLUDED.game_key,
          side       = EXCLUDED.side,
          line       = EXCLUDED.line,
          book       = EXCLUDED.book,
          price      = EXCLUDED.price,
          locked_at  = EXCLUDED.locked_at,
          alert_line = NULL,
          prop_meta  = EXCLUDED.prop_meta`));
    return json({ ok: true, count: picks.length });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
