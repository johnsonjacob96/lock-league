// /api/grade — runs as a Vercel Cron Tuesday 11:00 UTC (~6am ET).
// Pulls final scores for the just-finished NFL week from ESPN's scoreboard
// (free, no auth), updates games table, grades every pick whose game has finalized.
//
// Manual fire: GET /api/grade?week=N&season=YYYY  (requires CRON_SECRET in header)

import { sql } from "../lib/db.js";
import { currentNflWeek, BET_TYPES } from "../lib/nfl.js";

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// Map ESPN team display names → canonical (loose match works since we store raw names too)
function normTeam(s) {
  return s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

async function fetchScoreboard(season, week) {
  const url = new URL(ESPN_SCOREBOARD);
  url.searchParams.set("year", String(season));
  url.searchParams.set("seasontype", "2"); // regular season
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
      espn_id: ev.id,
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
  // pickSide = 'fav' or 'dog'; pickLine = the spread on the favorite (negative number)
  // favTeam = the team the line was on (the favorite at pick time)
  const margin = homeScore - awayScore; // positive = home won by N
  // If favTeam was home, fav margin = margin. If favTeam was away, fav margin = -margin.
  const favMargin = favTeam === homeTeam ? margin : -margin;
  const adjusted = favMargin + pickLine; // pickLine is negative; if fav wins by more than |line|, adjusted > 0
  if (adjusted === 0) return "P";
  const favCovered = adjusted > 0;
  return pickSide === "fav" ? (favCovered ? "W" : "L") : (favCovered ? "L" : "W");
}

function gradeTotal(side, line, total) {
  if (total === line) return "P";
  const wentOver = total > line;
  return side === "over" ? (wentOver ? "W" : "L") : (wentOver ? "W" : "L");
}

async function gradeWeek(season, week) {
  const events = await fetchScoreboard(season, week);
  let updated = 0, graded = 0;
  // Upsert games
  for (const ev of events) {
    if (!ev.home || !ev.away) continue;
    await sql()`
      INSERT INTO games (season, week, away, home, kickoff_at, away_score, home_score, status)
      VALUES (${season}, ${week}, ${ev.away}, ${ev.home}, ${ev.kickoff}, ${ev.away_score}, ${ev.home_score}, ${ev.status})
      ON CONFLICT (season, week, away, home)
      DO UPDATE SET away_score = EXCLUDED.away_score, home_score = EXCLUDED.home_score, status = EXCLUDED.status`;
    updated++;
  }
  // Grade picks (skip if already graded)
  const picks = await sql()`
    SELECT * FROM picks
    WHERE season = ${season} AND week = ${week} AND result IS NULL`;
  for (const p of picks) {
    // Match game by game_key like "AWAY@HOME" using normalized names
    if (!p.game_key) continue;
    const [pAway, pHome] = p.game_key.split("@");
    const ev = events.find(
      (e) => normTeam(e.away) === normTeam(pAway) && normTeam(e.home) === normTeam(pHome)
    );
    if (!ev || ev.status !== "final") continue;

    let result = null;
    if (p.bet_type === "Favorite" || p.bet_type === "Dog") {
      // p.line is the spread on the favorite (negative). For dog picks we store the same line but flip side.
      // Caller stored fav team as part of pick_text; for simplicity reconstruct from side: if side==='fav', favTeam was the favored side from books, but we don't have that here.
      // For now we approximate: the side 'fav' means user took the favorite, so the team that was favorite is whoever the book showed as fav at pick time. We need that team. Skip if missing.
      // (We'll re-engineer: pick_text usually contains "Team -X.X" so favTeam = first token before " -".)
      const m = (p.pick_text || "").match(/^([A-Za-z .'-]+?)\s+[-+]/);
      const favTeam = m ? m[1].trim() : null;
      if (!favTeam) continue;
      result = gradeSpread(p.side, Number(p.line), ev.away_score, ev.home_score, ev.away, ev.home, favTeam);
    } else if (p.bet_type === "Over" || p.bet_type === "Under") {
      const total = ev.home_score + ev.away_score;
      result = gradeTotal(p.side, Number(p.line), total);
    } else if (p.bet_type === "Super Lock") {
      // Player prop / specialty — manual grading only
      continue;
    }
    if (result) {
      await sql()`UPDATE picks SET result = ${result}, graded_at = NOW() WHERE id = ${p.id}`;
      graded++;
    }
  }
  return { week, events: updated, graded };
}

export default async function handler(req, res) {
  // Auth: Vercel Cron sends a special header, or accept CRON_SECRET via header
  const cronHeader = req.headers["x-vercel-cron"];
  const secret = req.headers["x-cron-secret"];
  const ok = cronHeader || (process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ error: "unauthorized" });

  // What week to grade? Default = last completed week (current - 1, or just-finished if cron Tuesday).
  let season = Number(req.query.season);
  let week = Number(req.query.week);
  if (!season || !week) {
    const cur = currentNflWeek();
    if (!cur.week) return res.status(200).json({ ok: true, note: "offseason" });
    season = cur.season;
    week = Math.max(1, cur.week - 1); // grade the just-finished week
  }
  try {
    const result = await gradeWeek(season, week);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
