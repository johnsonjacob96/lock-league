// Shared grading logic for /api/grade (manual + GitHub Actions cron).
// Mirrors lib/grader.js (kept in sync for Cloudflare Pages Functions runtime).
import { sql } from "./db.js";
import { weeksToGrade, currentNflWeek, seasonTypeFor, testConfig } from "./nfl.js";
import { pushPersonalized, alreadySent, markSent } from "./push-notify.js";
import { gradeProp } from "./props.js";
import { espnScoreboardEvents, espnBoxscore } from "./espn.js";

function normTeam(s) { return String(s || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// True when one name is (or contains) the other after normalization, so
// "Chiefs" matches "Kansas City Chiefs" and "49ers" matches "San Francisco 49ers".
export function sameTeam(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function fetchScoreboard(season, week, seasontype = 2) {
  const events = await espnScoreboardEvents(season, seasontype, week);
  return (events || []).map((ev) => {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const status = comp?.status?.type?.completed ? "final" : (ev.status?.type?.name || "scheduled");
    return {
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

export async function gradeWeek(env, season, week) {
  const s = sql(env);
  const events = await fetchScoreboard(season, week, seasonTypeFor(env));
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

    let result = null;
    if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
      if (ev.home_score == null || ev.away_score == null) continue;
      result = resolveSpreadResult(p, ev);
    } else if (p.bet_type === "Over" || p.bet_type === "Under") {
      if (ev.home_score == null || ev.away_score == null) continue;
      const total = ev.home_score + ev.away_score;
      result = gradeTotal(p.side, Number(p.line), total);
    } else if (p.bet_type === "Super Lock") {
      // Only structured Super Locks (prop_meta set) auto-grade; free-text ones
      // stay manual (mark-super-lock action).
      const meta = typeof p.prop_meta === "string" ? safeJson(p.prop_meta) : p.prop_meta;
      if (!meta || !meta.market) continue;
      let box = boxCache.get(ev.id);
      if (box === undefined) { box = await fetchBoxscore(ev.id); boxCache.set(ev.id, box); }
      if (!box) continue; // couldn't fetch -> retry next run
      result = gradeProp(meta, box); // may be null (player unmatched) -> leave for manual
    }
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
// most once per week (guarded by week_notifications).
export async function pushWeekResults(env, season, week) {
  if (await alreadySent(env, season, week, "winner")) return { skipped: "already-sent" };
  const rows = await sql(env)`
    SELECT p.member_id, m.name, p.result
    FROM picks p JOIN members m ON m.id = p.member_id
    WHERE p.season = ${season} AND p.week = ${week}`;
  if (!rows.length) return { skipped: "no-picks" };

  const rec = {};
  for (const r of rows) {
    const e = rec[r.member_id] || (rec[r.member_id] = { name: r.name, W: 0, L: 0, P: 0 });
    if (r.result === "W" || r.result === "L" || r.result === "P") e[r.result]++;
  }
  const ranked = Object.entries(rec).sort((a, b) => b[1].W - a[1].W || a[1].L - b[1].L);
  if (!ranked.length) return { skipped: "no-graded" };
  const [topId, top] = ranked[0];
  const tie = ranked.filter(([, c]) => c.W === top.W && c.L === top.L).length > 1;
  const winnerName = !tie && top.W > 0 ? top.name : null;
  const fmt = (c) => `${c.W}-${c.L}${c.P ? "-" + c.P : ""}`;

  const byMemberId = {};
  for (const [id, c] of Object.entries(rec)) {
    const isWinner = winnerName && Number(id) === Number(topId);
    byMemberId[id] = {
      title: isWinner ? `You won Week ${week}` : `Week ${week} is in the books`,
      body: isWinner
        ? `You took the week at ${fmt(c)}. Nice.`
        : winnerName
          ? `You went ${fmt(c)}. ${winnerName} won the week at ${fmt(top)}.`
          : `You went ${fmt(c)}. The top of the board tied this week.`,
      url: "/",
      tag: `ll-week-${season}-${week}`,
    };
  }
  const res = await pushPersonalized(env, byMemberId);
  await markSent(env, season, week, "winner");
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

  const s = sql(env);
  const blocks = [];
  for (const r of newly) {
    const rows = await s`
      SELECT m.name, p.result FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${r.season} AND p.week = ${r.week}`;
    blocks.push(weekSummaryText(r.week, rows, r.graded));
  }
  await sendGroupMessage(blocks.join("\n\n"), { discord, groupme });
  return true;
}

export function weekSummaryText(week, rows, newlyGraded) {
  const rec = {};
  let ungraded = 0;
  for (const row of rows) {
    const m = rec[row.name] || (rec[row.name] = { W: 0, L: 0, P: 0 });
    if (row.result) m[row.result]++;
    else ungraded++;
  }
  const sorted = Object.entries(rec).sort((a, b) => b[1].W - a[1].W || a[1].L - b[1].L);
  const lines = sorted
    .map(([name, c]) => `${name} ${c.W}-${c.L}${c.P ? "-" + c.P : ""}`)
    .join(" · ");
  let crown = "";
  if (sorted.length) {
    const [topName, top] = sorted[0];
    const tied = sorted.filter(([, c]) => c.W === top.W && c.L === top.L).length > 1;
    if (!tied && top.W > 0) crown = `\n${ungraded ? "📈 Leader" : "🏆 Winner"}: ${topName} (${top.W}-${top.L})`;
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
