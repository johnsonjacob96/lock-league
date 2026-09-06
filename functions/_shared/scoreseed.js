// Seeded ESPN scoreboard events, keyed by season/week/seasontype.
//
// The CF Worker can't reliably reach ESPN (site.api 403s the colo, cdn returns
// empty bodies), which breaks live scores, the War Room, and grading — all of
// which read the ESPN scoreboard. A GitHub runner CAN reach ESPN, so the
// preseason-seed workflow pushes the raw scoreboard events here (they carry
// scores + status), and fetchScoreboard falls back to them when the live fetch
// fails. Same pattern as the odds snapshot.
import { sql, ignoringConcurrentCreate } from "./db.js";

let ready = false;
async function ensure(env) {
  if (ready) return;
  await ignoringConcurrentCreate(sql(env)`CREATE TABLE IF NOT EXISTS scoreboard_snapshot (
    season     INT NOT NULL,
    week       INT NOT NULL,
    seasontype INT NOT NULL,
    events     JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, week, seasontype)
  )`);
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

let summariesReady = false;
async function ensureSummaries(env) {
  if (summariesReady) return;
  await ignoringConcurrentCreate(sql(env)`CREATE TABLE IF NOT EXISTS game_summary_snapshot (
    event_id TEXT PRIMARY KEY,
    summary JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  summariesReady = true;
}

export async function saveSummarySeed(env, eventId, summary) {
  try {
    await ensureSummaries(env);
    await sql(env)`INSERT INTO game_summary_snapshot (event_id, summary, updated_at)
      VALUES (${String(eventId)}, ${JSON.stringify(summary)}::jsonb, NOW())
      ON CONFLICT (event_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()`;
    return true;
  } catch { return false; }
}

export async function loadSummarySeed(env, eventId) {
  if (!env) return null;
  try {
    await ensureSummaries(env);
    const rows = await sql(env)`SELECT summary FROM game_summary_snapshot WHERE event_id = ${String(eventId)}`;
    return rows[0]?.summary || null;
  } catch { return null; }
}
