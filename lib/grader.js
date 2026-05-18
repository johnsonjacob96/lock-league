// Shared grading logic. Imported by /api/grade and the 4 scheduled crons.
import { sql } from "./db.js";

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
function normTeam(s) { return s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }

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
      home_score: home?.score ? Number(home.score) : null,
      away_score: away?.score ? Number(away.score) : null,
      kickoff: ev.date,
      status,
    };
  });
}

function gradeSpread(pickSide, pickLine, awayScore, homeScore, awayTeam, homeTeam, favTeam) {
  const margin = homeScore - awayScore;
  const favMargin = favTeam === homeTeam ? margin : -margin;
  const adjusted = favMargin + pickLine;
  if (adjusted === 0) return "P";
  const favCovered = adjusted > 0;
  return pickSide === "fav" ? (favCovered ? "W" : "L") : (favCovered ? "L" : "W");
}
function gradeTotal(side, line, total) {
  if (total === line) return "P";
  const wentOver = total > line;
  return side === "over" ? (wentOver ? "W" : "L") : (wentOver ? "L" : "W");
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
    const ev = events.find((e) => normTeam(e.away) === normTeam(pAway) && normTeam(e.home) === normTeam(pHome));
    if (!ev || ev.status !== "final") continue;

    let result = null;
    if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
      const m = (p.pick_text || "").match(/^([A-Za-z .'-]+?)\s+[-+]/);
      const favTeam = m ? m[1].trim() : null;
      if (!favTeam) continue;
      result = gradeSpread(p.side, Number(p.line), ev.away_score, ev.home_score, ev.away, ev.home, favTeam);
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
