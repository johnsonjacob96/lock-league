// Shared grading logic. Imported by /api/grade and the scheduled crons.
import { sql } from "./db.js";
import { weeksToGrade } from "./nfl.js";

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
function normTeam(s) { return String(s || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }

// True when one name is (or contains) the other after normalization, so
// "Chiefs" matches "Kansas City Chiefs" and "49ers" matches "San Francisco 49ers".
function sameTeam(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function fetchScoreboard(season, week) {
  const url = new URL(ESPN_SCOREBOARD);
  url.searchParams.set("year", String(season));
  url.searchParams.set("seasontype", "2");
  url.searchParams.set("week", String(week));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`espn ${r.status}`);
  const data = await r.json();
  return (data.events || []).map((ev) => {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const status = comp?.status?.type?.completed ? "final" : (ev.status?.type?.name || "scheduled");
    return {
      home: home?.team?.displayName,
      away: away?.team?.displayName,
      home_score: home?.score != null ? Number(home.score) : null,
      away_score: away?.score != null ? Number(away.score) : null,
      kickoff: ev.date,
      status,
    };
  });
}

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

export async function gradeWeek(season, week) {
  const s = sql();
  const events = await fetchScoreboard(season, week);
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
  // Only grade picks whose game is final AND not yet graded
  const picks = await s`
    SELECT * FROM picks WHERE season = ${season} AND week = ${week} AND result IS NULL`;
  for (const p of picks) {
    if (!p.game_key) continue; // free-text picks (incl. Super Lock) need manual mark
    const [pAway, pHome] = p.game_key.split("@");
    const ev = events.find((e) => sameTeam(e.away, pAway) && sameTeam(e.home, pHome));
    if (!ev || ev.status !== "final") continue;
    if (ev.home_score == null || ev.away_score == null) continue;

    let result = null;
    if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
      result = resolveSpreadResult(p, ev);
    } else if (p.bet_type === "Over" || p.bet_type === "Under") {
      const total = ev.home_score + ev.away_score;
      result = gradeTotal(p.side, Number(p.line), total);
    } else if (p.bet_type === "Super Lock") {
      continue; // player props / specialty — manual via mark-super-lock action
    }
    if (result) {
      await s`UPDATE picks SET result = ${result}, graded_at = NOW() WHERE id = ${p.id}`;
      graded++;
    }
  }
  return { season, week, events: updated, graded };
}

// Grade every week a scheduled run should cover (current + previous).
export async function gradeCurrentWeeks(now = new Date()) {
  const weeks = weeksToGrade(now);
  const results = [];
  for (const week of weeks) {
    results.push(await gradeWeek(2026, week));
  }
  return { ran: weeks.length, results };
}
