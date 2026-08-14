// /api/warroom — live Sunday leaderboard. Joins the current week's locked picks
// with the live ESPN scoreboard and computes each member's live record using the
// same grading math as the auto-grader. Login required; picks stay hidden until
// the weekly lock (noon CT Sunday), same as everywhere else.
import { verifyCookie, json } from "../_shared/auth.js";
import { currentNflWeek, pickCutoff, seasonTypeFor } from "../_shared/nfl.js";
import { fetchScoreboard, resolveSpreadResult, gradeTotal, sameTeam, maybeGrade } from "../_shared/grader.js";
import { sql } from "../_shared/db.js";

const TTL_MS = 40 * 1000;
let cache = { ts: 0, key: "", data: null };

// A full card is one pick of each type. Cards always render all five slots in
// this order; a slot a member never filled is an automatic loss once picks lock.
const BET_TYPES_ORDER = ["Favorite", "Dog", "Over", "Under", "Super Lock"];

const safeJson = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

// Live standing of one pick against the (possibly in-progress) game.
function livePickStatus(p, ev) {
  if (!ev) return { status: "pending", state: "pre" };
  const st = ev.state; // 'pre' | 'in' | 'post'
  if (st === "pre" || ev.home_score == null || ev.away_score == null) {
    return { status: "pending", state: st, detail: ev.detail };
  }
  const map = { W: "win", L: "lose", P: "push" };
  let result = null;
  if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
    result = resolveSpreadResult(p, ev);
  } else if (p.bet_type === "Over" || p.bet_type === "Under") {
    result = gradeTotal(p.side, Number(p.line), ev.home_score + ev.away_score);
  } else if (p.bet_type === "Super Lock") {
    // A game-line Super Lock (spread/total) grades live off the score, same as
    // the gradable bets. Player-prop and free-text Super Locks need the box
    // score / a manual mark, so they stay "manual" here.
    const meta = safeJson(p.prop_meta);
    if (meta && meta.kind === "spread") result = resolveSpreadResult(p, ev);
    else if (meta && meta.kind === "total") result = gradeTotal(p.side, Number(p.line), ev.home_score + ev.away_score);
    else return { status: "manual", state: st, detail: ev.detail, final: st === "post" };
  }
  return { status: result ? map[result] : "pending", state: st, final: st === "post", detail: ev.detail };
}

// Aggregate the league's lean per game (counts only, never who-picked-what).
// Favorite/Dog collapse onto the two sides of each spread via the team parsed
// from pick_text (same convention the grader uses); Over/Under tally per game.
// Exported for unit testing (Pages ignores non-handler exports at runtime).
export function computeConsensus(picks, evLookup) {
  const games = new Map();
  const teamOf = (p, ev) => {
    const m = (p.pick_text || "").match(/^(.+?)\s+[-+]\d/);
    if (!m) return null;
    const picked = m[1].trim();
    if (ev) {
      if (sameTeam(picked, ev.home)) return ev.home;
      if (sameTeam(picked, ev.away)) return ev.away;
    }
    return picked;
  };
  for (const p of picks) {
    if (!p.game_key) continue;
    const ev = evLookup ? evLookup(p.game_key) : null;
    const [awayKey, homeKey] = String(p.game_key).split("@");
    let g = games.get(p.game_key);
    if (!g) {
      g = { game_key: p.game_key, away: ev?.away || awayKey, home: ev?.home || homeKey,
            teams: new Map(), over: 0, under: 0, line: null };
      games.set(p.game_key, g);
    }
    if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
      const team = teamOf(p, ev);
      if (team) g.teams.set(team, (g.teams.get(team) || 0) + 1);
    } else if (p.bet_type === "Over") { g.over++; if (g.line == null && p.line != null) g.line = Number(p.line); }
    else if (p.bet_type === "Under") { g.under++; if (g.line == null && p.line != null) g.line = Number(p.line); }
  }
  return [...games.values()].map((g) => {
    const spread = [...g.teams.entries()].map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count);
    const spreadN = spread.reduce((s, x) => s + x.count, 0);
    const totalN = g.over + g.under;
    return {
      game_key: g.game_key, away: g.away, home: g.home, spread,
      total: totalN ? { over: g.over, under: g.under, line: g.line } : null,
      n: spreadN + totalN,
    };
  }).filter((g) => g.n >= 2).sort((a, b) => b.n - a.n);
}

export async function onRequest({ request, env, waitUntil }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
  // Grade newly-final games in the background as the War Room is polled.
  if (waitUntil) waitUntil(maybeGrade(env).catch(() => {}));

  const cur = currentNflWeek(new Date(), env);
  if (!cur.week) return json({ season: cur.season, week: null, status: cur.status, revealed: false, members: [] });

  const now = Date.now();
  const cutoff = pickCutoff(cur.season, cur.week, env);
  const globalRevealed = now >= cutoff.getTime();

  const key = `${cur.season}:${cur.week}`;
  if (cache.data && cache.key === key && now - cache.ts < TTL_MS) {
    return json({ ...cache.data, cached: true });
  }

  const [picks, events, roster] = await Promise.all([
    sql(env)`
      SELECT p.member_id, m.name, p.bet_type, p.pick_text, p.game_key, p.side, p.line, p.result, p.prop_meta
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${cur.season} AND p.week = ${cur.week}
      ORDER BY m.name`,
    fetchScoreboard(cur.season, cur.week, seasonTypeFor(env), env).catch(() => []),
    sql(env)`SELECT id, name FROM members ORDER BY name`,
  ]);

  // If the scoreboard came back empty (ESPN threw AND there was no cache/seed to
  // fall back on — a cold isolate during a colo throttle), don't overwrite a
  // previously-good board with a blank, scores-dropped, not-live one. Serve the
  // last good board; the next poll refreshes it once the scoreboard is back.
  if (!events.length && cache.data && cache.key === key && cache.data.revealed) {
    return json({ ...cache.data, cached: true, stale: true });
  }

  const findEv = (gameKey) => {
    if (!gameKey) return null;
    const [a, h] = gameKey.split("@");
    return events.find((e) => sameTeam(e.away, a) && sameTeam(e.home, h)) || null;
  };

  // The War Room lights up the instant the week's FIRST game kicks off (Thursday
  // night TNF), not at the Sunday-noon weekly cutoff. Each member's pick is
  // revealed the moment ITS game starts — the same instant that pick locks (see
  // picks.js findStartedGame, ev.kickoff <= now) — so a revealed pick can never
  // be changed, and picks on games that haven't kicked off stay hidden. Once the
  // Sunday cutoff passes, every pick is public regardless of game state.
  const started = (ev) =>
    !!ev && ((ev.kickoff && new Date(ev.kickoff).getTime() <= now) || ev.state === "in" || ev.state === "post");
  const revealed = globalRevealed || events.some(started);
  if (!revealed) {
    const nextKick = events
      .map((e) => (e.kickoff ? new Date(e.kickoff).getTime() : 0))
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    const data = { season: cur.season, week: cur.week, revealed: false,
      cutoff: cutoff.toISOString(), firstKickoff: nextKick ? new Date(nextKick).toISOString() : null };
    cache = { ts: now, key, data };
    return json(data);
  }
  // Per-game reveal gate: show a pick only once its game has kicked off (or the
  // weekly cutoff has passed). Super Locks with no game tie only reveal at cutoff.
  const pickRevealed = (p) => globalRevealed || started(findEv(p.game_key));

  // Index every submitted pick by member + bet type, so each card can render all
  // five slots (a blank where a member didn't pick) in the canonical order.
  const submitted = new Map(); // member_id -> { [bet_type]: pickRow }
  for (const p of picks) {
    let e = submitted.get(p.member_id);
    if (!e) { e = {}; submitted.set(p.member_id, e); }
    e[p.bet_type] = p;
  }

  const byMember = new Map();
  for (const mem of roster) {
    // W/L/P = projected record (final + still-live results). fW/fL/fP = the
    // portion that's actually final, so the UI can flag a record as PROJ while
    // any counted game is still in progress.
    const m = { member_id: mem.id, name: mem.name, picks: [],
      live: { W: 0, L: 0, P: 0, fW: 0, fL: 0, fP: 0, pending: 0 } };
    const byType = submitted.get(mem.id) || {};
    for (const bt of BET_TYPES_ORDER) {
      const p = byType[bt];
      if (p && pickRevealed(p)) {
        const ev = findEv(p.game_key);
        // Trust a stored result if already graded; otherwise compute live.
        let s;
        if (p.result === "W") s = { status: "win", final: true, state: "post" };
        else if (p.result === "L") s = { status: "lose", final: true, state: "post" };
        else if (p.result === "P") s = { status: "push", final: true, state: "post" };
        else s = livePickStatus(p, ev);
        // Only surface a running score once the game is actually live/final. ESPN
        // toggles a scheduled game's competitor score between "0" and null, which
        // otherwise made the scoreline flicker between "0-0" and the kickoff time.
        const gameLive = !!ev && (ev.state === "in" || ev.state === "post");
        m.picks.push({
          bet_type: bt, kind: "pick", pick_text: p.pick_text,
          status: s.status, final: !!s.final, state: s.state || null,
          detail: s.detail || (ev && ev.detail) || null,
          kickoff: ev && ev.kickoff ? ev.kickoff : null,
          score: gameLive && ev.away_score != null
            ? { away: ev.away, home: ev.home, away_score: ev.away_score, home_score: ev.home_score }
            : null,
        });
        if (s.status === "win") { m.live.W++; if (s.final) m.live.fW++; }
        else if (s.status === "lose") { m.live.L++; if (s.final) m.live.fL++; }
        else if (s.status === "push") { m.live.P++; if (s.final) m.live.fP++; }
        else m.live.pending++;
      } else if (globalRevealed) {
        // Picks are locked and this slot was never filled -> an automatic loss.
        // (If a pick existed here it would be revealed above, since the lock
        // reveals everything, so reaching this branch means the slot is empty.)
        m.picks.push({ bet_type: bt, kind: "missing", status: "lose", final: true });
        m.live.L++; m.live.fL++;
      } else {
        // Before the Sunday lock: this pick's game hasn't kicked off yet (a pick
        // shows the instant ITS game starts, so Thursday picks appear while the
        // rest wait), OR the slot is empty. Both render an identical placeholder,
        // so the board never leaks whether/what a member picked for a game that
        // hasn't started, and nothing is counted as a loss yet.
        m.picks.push({ bet_type: bt, kind: "hidden" });
      }
    }
    byMember.set(mem.id, m);
  }

  const members = [...byMember.values()].sort(
    (a, b) => b.live.W - a.live.W || a.live.L - b.live.L || a.name.localeCompare(b.name));
  const anyLive = events.some((e) => e.state === "in");

  // Recap: once every game this week is final, summarize the week.
  let recap = null;
  const allFinal = events.length > 0 && events.every((e) => e.state === "post");
  if (allFinal && members.length) {
    const top = members[0];
    const tie = members.filter((m) => m.live.W === top.live.W && m.live.L === top.live.L).length > 1;
    const winner = !tie && top.live.W > 0 ? { name: top.name, W: top.live.W, L: top.live.L } : null;
    const perfect = members
      .filter((m) => m.live.W > 0 && m.live.L === 0 && m.live.pending === 0)
      .map((m) => m.name);
    recap = { complete: true, winner, tie, perfect };
  }

  let consensus = [];
  try { consensus = computeConsensus(picks.filter(pickRevealed), findEv); } catch { consensus = []; }

  const data = { season: cur.season, week: cur.week, revealed: true, fetched_at: new Date().toISOString(), anyLive, members, recap, consensus };
  cache = { ts: Date.now(), key, data };
  return json(data);
}
