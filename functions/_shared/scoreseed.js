// Seeded ESPN scoreboard events, keyed by season/week/seasontype.
//
// The CF Worker can't reliably reach ESPN (site.api 403s the colo, cdn returns
// empty bodies), which breaks live scores, the War Room, and grading — all of
// which read the ESPN scoreboard. A GitHub runner CAN reach ESPN, so the
// preseason-seed workflow pushes the raw scoreboard events here (they carry
// scores + status), and fetchScoreboard falls back to them when the live fetch
// fails. Same pattern as the odds snapshot.
import { sql } from "./db.js";

let ready = false;
async function ensure(env) {
  if (ready) return;
  await sql(env)`CREATE TABLE IF NOT EXISTS scoreboard_snapshot (
    season     INT NOT NULL,
    week       INT NOT NULL,
    seasontype INT NOT NULL,
    events     JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, week, seasontype)
  )`;
  ready = true;
}

export async function saveScoreboardSeed(env, season, week, seasontype, events) {
  try {
    await ensure(env);
    await sql(env)`
      INSERT INTO scoreboard_snapshot (season, week, seasontype, events, updated_at)
      VALUES (${season}, ${week}, ${seasontype}, ${JSON.stringify(events)}::jsonb, NOW())
      ON CONFLICT (season, week, seasontype)
      DO UPDATE SET events = EXCLUDED.events, updated_at = NOW()`;
    return true;
  } catch {
    return false;
  }
}

export async function loadScoreboardSeed(env, season, week, seasontype) {
  try {
    await ensure(env);
    const rows = await sql(env)`
      SELECT events FROM scoreboard_snapshot
      WHERE season = ${season} AND week = ${week} AND seasontype = ${seasontype}`;
    if (rows.length) return rows[0].events;
  } catch { /* none yet */ }
  return null;
}
