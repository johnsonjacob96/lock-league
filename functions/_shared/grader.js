// Shared grading logic for /api/grade (manual + GitHub Actions cron).
// Mirrors lib/grader.js (kept in sync for Cloudflare Pages Functions runtime).
import { sql } from "./db.js";
import { weeksToGrade, currentNflWeek, pickCutoff, seasonTypeFor, testConfig } from "./nfl.js";
import { pushPersonalized, claimSend } from "./push-notify.js";
import { gradeProp } from "./props.js";
import { espnScoreboardEvents, espnBoxscore } from "./espn.js";
import { loadScoreboardSeed } from "./scoreseed.js";
import { weeklyMemberRecords, weeklyWinner } from "./standings.js";

function normTeam(s) { return String(s || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// True when one name is (or contains) the other after normalization, so
// "Chiefs" matches "Kansas City Chiefs" and "49ers" matches "San Francisco 49ers".
export function sameTeam(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Last-good scoreboard cache, per isolate, keyed by season:week:seasontype.
// ESPN's hosts intermittently throttle the CF colo (site.api 403s, cdn returns
// empty bodies). Without this, a single failed poll blanked the War Room's
// scores and flipped it out of "live" ("dropping scores / isn't live"), because
// warroom.js swallows a throw into an empty scoreboard. Two jobs: (a) collapse
// the burst of fetches one request triggers — the board plus the waitUntil
// maybeGrade — into a single upstream hit; (b) serve the last scoreboard we
// successfully fetched through a transient failure. Stale live scores beat a
// blank board, and the seed / next good fetch refreshes it.
const _sbCache = new Map();
const SB_TTL_MS = 25 * 1000;

export async function fetchScoreboard(season, week, seasontype = 2, env = null) {
  const cacheKey = `${season}:${week}:${seasontype}`;
  const cached = _sbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SB_TTL_MS) return cached.events;

  let raw = null;
  let sourceUpdatedAt = new Date().toISOString();
  try {
    raw = await espnScoreboardEvents(season, seasontype, week);
  } catch (e) {
    // Re-read the runner snapshot before falling back to expired isolate data.
    // Otherwise a sustained ESPN outage freezes this isolate's scores forever.
    if (env) raw = await loadScoreboardSeed(env, season, week, seasontype);
    sourceUpdatedAt = raw?.source_updated_at || null;
    if (!raw?.length) {
      if (cached) return cached.events;
      throw e;
    }
  }
  const events = (raw || []).map((ev) => {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const status = (comp?.status?.type?.completed || ev.status?.type?.completed) ? "final" : (ev.status?.type?.name || "scheduled");
    return {
      source_updated_at: sourceUpdatedAt,
      id: ev.id, // ESPN event id, for the box-score summary (prop grading)
      home: home?.team?.displayName,
      away: away?.team?.displayName,
      home_score: home?.score != null ? Number(home.score) : null,
      away_score: away?.score != null ? Number(away.score) : null,
      kickoff: ev.date,
      status,
      state: ev.status?.type?.state || (comp?.status?.type?.completed ? "post" : "pre"), // 'pre' | 'in' | 'post'
      detail: ev.status?.type?.shortDetail || "", // e.g. "Q3 5:24" / "Final"
    };
  });
  // Never let an empty result become the "last good" — keep any prior good one.
  if (events.length) _sbCache.set(cacheKey, { ts: Date.now(), events });
  return events;
}

// Fetch one game's ESPN box score (player stat lines) for prop grading.
// Returns the boxscore object or null. Callers memoize per grade run so a week
// with several Super Locks in the same game only fetches it once. (Delegates to
// the shared ESPN helper, which handles the site.api -> cdn host fallback.)
export const fetchBoxscore = espnBoxscore;

export function gradeSpread(pickSide, favLine, awayScore, homeScore, favIsHome) {
  const favMargin = favIsHome ? homeScore - awayScore : awayScore - homeScore;
  const adjusted = favMargin + favLine; // favLine is the favorite's negative number
  if (adjusted === 0) return "P";
  const favCovered = adjusted > 0;
  return pickSide === "fav" ? (favCovered ? "W" : "L") : (favCovered ? "L" : "W");
}

export function gradeTotal(side, line, total) {
  if (total === line) return "P";
  const wentOver = total > line;
  return side === "over" ? (wentOver ? "W" : "L") : (wentOver ? "L" : "W");
}

// Grade a Favorite/Dog pick against a final game. pick_text starts with the
// *picked* team ("Kansas City Chiefs -3.5", "San Francisco 49ers +6");
// p.side says whether that team is the favorite or the dog, and p.line is
// the favorite's (negative) spread. Returns 'W'|'L'|'P' or null if the
// pick can't be resolved (leave for manual review).
export function resolveSpreadResult(p, ev) {
  if (p.side !== "fav" && p.side !== "dog") return null;
  const m = (p.pick_text || "").match(/^(.+?)\s+[-+]\d/);
  if (!m) return null;
  const picked = m[1].trim();
  const pickedIsHome = sameTeam(picked, ev.home);
  const pickedIsAway = sameTeam(picked, ev.away);
  if (pickedIsHome === pickedIsAway) return null; // no match, or ambiguous
  const favIsHome = p.side === "fav" ? pickedIsHome : !pickedIsHome;
  const favLine = -Math.abs(Number(p.line));
  if (Number.isNaN(favLine)) return null;
  return gradeSpread(p.side, favLine, ev.away_score, ev.home_score, favIsHome);
}

// Route a single pick to the right grader against a FINAL event. This is the
// authoritative grading router used by gradeWeek — kept pure (except getBox, an
// injected `(eventId) -> boxscore` so it runs without ESPN) so the exact routing
// is smoke-tested. Returns 'W'|'L'|'P', or null when the pick can't be auto-graded
// (missing scores, an unmatched player, or a free-text Super Lock -> manual).
export async function resolvePickResult(p, ev, getBox) {
  const haveScore = ev && ev.home_score != null && ev.away_score != null;
  const total = () => ev.home_score + ev.away_score;
  if (p.bet_type === "Favorite" || p.bet_type === "Dog") return haveScore ? resolveSpreadResult(p, ev) : null;
  if (p.bet_type === "Over" || p.bet_type === "Under") return haveScore ? gradeTotal(p.side, Number(p.line), total()) : null;
  if (p.bet_type === "Super Lock") {
    const meta = typeof p.prop_meta === "string" ? safeJson(p.prop_meta) : p.prop_meta;
    if (!meta) return null;                                                    // free-text -> manual
    if (meta.kind === "spread") return haveScore ? resolveSpreadResult(p, ev) : null; // game-line SL (spread)
    if (meta.kind === "total") return haveScore ? gradeTotal(p.side, Number(p.line), total()) : null; // game-line SL (total)
    if (meta.market) { const box = getBox ? await getBox(ev.id) : null; return box ? gradeProp(meta, box) : null; } // player prop
    return null;
  }
  return null;
}

export async function gradeWeek(env, season, week) {
  const s = sql(env);
  const events = await fetchScoreboard(season, week, seasonTypeFor(env), env);
  let updated = 0, graded = 0;
  for (const ev of events) {
    if (!ev.home || !ev.away) continue;
    await s`
      INSERT INTO games (season, week, away, home, kickoff_at, away_score, home_score, status)
      VALUES (${season}, ${week}, ${ev.away}, ${ev.home}, ${ev.kickoff}, ${ev.away_score}, ${ev.home_score}, ${ev.status})
      ON CONFLICT (season, week, away, home)
      DO UPDATE SET away_score = EXCLUDED.away_score, home_score = EXCLUDED.home_score, status = EXCLUDED.status`;
    updated++;
  }
  const picks = await s`
    SELECT * FROM picks WHERE season = ${season} AND week = ${week} AND result IS NULL`;
  const boxCache = new Map(); // eventId -> boxscore (fetched at most once per run)
  for (const p of picks) {
    if (!p.game_key) continue; // free-text picks (incl. free-text Super Lock) need manual mark
    const [pAway, pHome] = p.game_key.split("@");
    const ev = events.find((e) => sameTeam(e.away, pAway) && sameTeam(e.home, pHome));
    if (!ev || ev.status !== "final") continue;

    const result = await resolvePickResult(p, ev, async (id) => {
      let box = boxCache.get(id);
      if (box === undefined) { box = await fetchBoxscore(id, env); boxCache.set(id, box); }
      return box; // fetched at most once per event per run; null on failure -> skip (retry next run)
    });
    if (result) {
      await s`UPDATE picks SET result = ${result}, graded_at = NOW() WHERE id = ${p.id}`;
      graded++;
    }
  }
  const allFinal = events.length > 0 && events.every((e) => e.state === "post");
  return { season, week, events: updated, graded, allFinal };
}

// Grade every week a scheduled run should cover (current + previous),
// then push a summary to the group chat if webhooks are configured, plus a
// per-member Web Push once each week is complete.
export async function gradeCurrentWeeks(env, now = new Date()) {
  const weeks = weeksToGrade(now, env);
  const results = [];
  for (const week of weeks) {
    results.push(await gradeWeek(env, 2026, week));
  }
  const notified = await notifyGradeResults(results, env).catch(() => false);
  const pushed = [];
  for (const r of results) {
    // Regular season: a week is done once the season has moved past it. Under
    // preseason test mode there is no "next week", so gate on all games final.
    const complete = testConfig(env) ? r.allFinal : isWeekComplete(2026, r.week, now);
    if (complete) {
      const pr = await pushWeekResults(env, 2026, r.week).catch((e) => ({ error: e.message }));
      pushed.push({ week: r.week, ...pr });
    }
  }
  return { ran: weeks.length, results, notified, pushed };
}

// Opportunistic grading: called best-effort (and throttled) from read paths so
// picks grade within ~a minute of a game finishing, instead of waiting for the
// sparse cron. Safe to call often — grading only touches ungraded picks, and the
// winner push is guarded to once per week. Returns quickly when there's nothing
// to do so it can run inside waitUntil() without slowing responses.
let lastOpportunisticGrade = 0;
export async function maybeGrade(env, now = Date.now()) {
  if (now - lastOpportunisticGrade < 60000) return { skipped: "throttled" };
  lastOpportunisticGrade = now;
  const cur = currentNflWeek(new Date(now), env);
  if (!cur.week) return { skipped: "no-week" };
  try {
    // Only fetch scores + grade if some game-linked pick this week is still open.
    const pending = await sql(env)`
      SELECT 1 FROM picks
      WHERE season = ${cur.season} AND week = ${cur.week}
        AND result IS NULL AND game_key IS NOT NULL
      LIMIT 1`;
    if (!pending.length) return { skipped: "nothing-ungraded" };
    return await gradeCurrentWeeks(env, new Date(now));
  } catch (e) {
    return { error: e.message };
  }
}

// A week is "complete" once the season has moved past it (the Tuesday grade run
// after MNF), so the winner push fires once, not mid-week.
function isWeekComplete(season, week, now) {
  const c = currentNflWeek(now);
  if (c.status === "postseason") return true;
  return c.week != null && week < c.week;
}

// Web Push: tell each member their week record, and crown the winner. Sent at
// most once per week — claimSend() atomically reserves the (season, week,
// "winner") slot before anything is sent, so concurrent isolates racing to
// grade the same week's finished games can't each pass a check-then-act
// guard and duplicate the blast.
export async function pushWeekResults(env, season, week) {
  const [members, picks] = await Promise.all([
    sql(env)`SELECT id, name FROM members`,
    sql(env)`SELECT member_id, bet_type, result FROM picks WHERE season = ${season} AND week = ${week}`,
  ]);
  if (!picks.length) return { skipped: "no-picks" };
  const locked = Date.now() >= pickCutoff(season, week, env).getTime();
  const records = weeklyMemberRecords(members.map((m) => m.id), picks, { locked });
  if (!locked || [...records.values()].some(r => r.pending)) return { skipped: "pending-results" };
  // Claim the send slot right before computing/sending (not at the top of the
  // function) so an early "no-picks" bail never permanently locks out a week
  // that later gets picks.
  if (!(await claimSend(env, season, week, "winner"))) return { skipped: "already-sent" };

  const win = weeklyWinner(records);
  const winnerName = win ? members.find((m) => m.id === win.member_id)?.name : null;
  const fmt = (c) => `${c.W}-${c.L}${c.P ? "-" + c.P : ""}`;

  const byMemberId = {};
  for (const m of members) {
    const r = records.get(m.id);
    if (!r || !(r.W || r.L || r.P || r.pending)) continue; // no activity this week
    const isWinner = win && m.id === win.member_id;
    byMemberId[m.id] = {
      title: isWinner ? `You won Week ${week}` : `Week ${week} is in the books`,
      body: isWinner
        ? `You took the week at ${fmt(r)}. Nice.`
        : winnerName
          ? `You went ${fmt(r)}. ${winnerName} won the week at ${fmt(records.get(win.member_id))}.`
          : `You went ${fmt(r)}. The top of the board tied this week.`,
      url: "/",
      tag: `ll-week-${season}-${week}`,
    };
  }
  const res = await pushPersonalized(env, byMemberId, "results");
  return { winner: winnerName, ...res };
}

// ---- Group-chat notifications (Discord webhook and/or GroupMe bot) ----
// Configure DISCORD_WEBHOOK_URL and/or GROUPME_BOT_ID; silent no-op otherwise.
export async function notifyGradeResults(results, env) {
  const discord = env?.DISCORD_WEBHOOK_URL;
  const groupme = env?.GROUPME_BOT_ID;
  if (!discord && !groupme) return false;
  const newly = (results || []).filter((r) => r.graded > 0);
  if (!newly.length) return false; // only ping the group when something new graded

  const members = await sql(env)`SELECT id, name FROM members`;
  const blocks = [];
  for (const r of newly) {
    const picks = await sql(env)`
      SELECT member_id, bet_type, result FROM picks WHERE season = ${r.season} AND week = ${r.week}`;
    const locked = Date.now() >= pickCutoff(r.season, r.week, env).getTime();
    const records = weeklyMemberRecords(members.map((m) => m.id), picks, { locked });
    blocks.push(weekSummaryText(r.week, members, records, r.graded));
  }
  await sendGroupMessage(blocks.join("\n\n"), { discord, groupme });
  return true;
}

export function weekSummaryText(week, members, records, newlyGraded) {
  const active = members
    .map((m) => ({ name: m.name, r: records.get(m.id) }))
    .filter(({ r }) => r && (r.W || r.L || r.P || r.pending));
  const ungraded = active.reduce((n, { r }) => n + r.pending, 0);
  const sorted = active.sort((a, b) => b.r.W - a.r.W || a.r.L - b.r.L);
  const lines = sorted
    .map(({ name, r }) => `${name} ${r.W}-${r.L}${r.P ? "-" + r.P : ""}`)
    .join(" · ");
  let crown = "";
  if (sorted.length) {
    const top = sorted[0];
    const tied = sorted.filter(({ r }) => r.W === top.r.W && r.L === top.r.L).length > 1;
    if (!tied && top.r.W > 0) crown = `\n${ungraded ? "📈 Leader" : "🏆 Winner"}: ${top.name} (${top.r.W}-${top.r.L})`;
  }
  return `🏈 Lock League — Week ${week} update (${newlyGraded} new grade${newlyGraded === 1 ? "" : "s"})\n${lines}${crown}`;
}

async function sendGroupMessage(text, { discord, groupme }) {
  const jobs = [];
  if (discord) {
    jobs.push(fetch(discord, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
    }));
  }
  if (groupme) {
    jobs.push(fetch("https://api.groupme.com/v3/bots/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: groupme, text: text.slice(0, 950) }),
    }));
  }
  await Promise.allSettled(jobs);
}
