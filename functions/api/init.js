// /api/init — one-shot DB bootstrap.
// Creates schema, seeds members with starter passphrases, imports historical
// picks from data/seasons.json (loaded via env.ASSETS). Idempotent.
//
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
//
// NOTE: Renamed from /api/_init (Netlify) to /api/init for Cloudflare Pages routing.
import bcrypt from "bcryptjs";
import { sql } from "../_shared/db.js";

const MEMBERS = ["Brayden", "Chase", "Chris", "Jack", "Jacob", "Jared", "Mason", "Tyler"];

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function createSchema(env) {
  const s = sql(env);
  await s`CREATE TABLE IF NOT EXISTS members (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    passphrase_h  TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`;
  await s`CREATE TABLE IF NOT EXISTS picks (
    id            SERIAL PRIMARY KEY,
    member_id     INT NOT NULL REFERENCES members(id),
    season        INT NOT NULL,
    week          INT NOT NULL,
    bet_type      TEXT NOT NULL,
    pick_text     TEXT NOT NULL,
    game_key      TEXT,
    side          TEXT,
    line          NUMERIC,
    book          TEXT,
    price         INT,
    result        TEXT,
    graded_at     TIMESTAMPTZ,
    locked_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(member_id, season, week, bet_type)
  )`;
  await s`CREATE TABLE IF NOT EXISTS games (
    id            SERIAL PRIMARY KEY,
    season        INT NOT NULL,
    week          INT NOT NULL,
    away          TEXT NOT NULL,
    home          TEXT NOT NULL,
    kickoff_at    TIMESTAMPTZ,
    away_score    INT,
    home_score    INT,
    closing_fav_line  NUMERIC,
    closing_total     NUMERIC,
    status        TEXT DEFAULT 'scheduled',
    UNIQUE(season, week, away, home)
  )`;
  await s`CREATE INDEX IF NOT EXISTS picks_season_week ON picks(season, week)`;
  await s`CREATE INDEX IF NOT EXISTS picks_member ON picks(member_id)`;
  await s`CREATE INDEX IF NOT EXISTS games_season_week ON games(season, week)`;
}

async function seedMembers(env) {
  const seeded = [];
  for (const name of MEMBERS) {
    const passphrase = name.toLowerCase() + "2026";
    const hash = await bcrypt.hash(passphrase, 10);
    await sql(env)`
      INSERT INTO members (name, passphrase_h)
      VALUES (${name}, ${hash})
      ON CONFLICT (name) DO NOTHING`;
    seeded.push({ name, initial_passphrase: passphrase });
  }
  return seeded;
}

async function importHistory(env, request) {
  const s = sql(env);
  const memRows = await s`SELECT id, name FROM members`;
  const memIdByName = Object.fromEntries(memRows.map(r => [r.name, r.id]));

  // Load historical data from static assets
  const resp = await env.ASSETS.fetch(new URL("/data/seasons.json", request.url));
  if (!resp.ok) throw new Error(`Failed to load seasons.json: ${resp.status}`);
  const historicalData = await resp.json();

  const memberIds = [], seasons = [], weeks = [], betTypes = [], pickTexts = [], results = [];
  for (const [memberName, years] of Object.entries(historicalData.members || {})) {
    const memId = memIdByName[memberName];
    if (!memId) continue;
    for (const [year, info] of Object.entries(years)) {
      for (const [bt, btInfo] of Object.entries(info.byType || {})) {
        for (const [wk, pick] of Object.entries(btInfo.picks || {})) {
          memberIds.push(memId);
          seasons.push(Number(year));
          weeks.push(Number(wk));
          betTypes.push(bt);
          pickTexts.push(pick.text || "");
          results.push(pick.result || null);
        }
      }
    }
  }

  if (!memberIds.length) return 0;

  await s`
    INSERT INTO picks (member_id, season, week, bet_type, pick_text, result)
    SELECT * FROM unnest(
      ${memberIds}::int[],
      ${seasons}::int[],
      ${weeks}::int[],
      ${betTypes}::text[],
      ${pickTexts}::text[],
      ${results}::text[]
    )
    ON CONFLICT (member_id, season, week, bet_type) DO NOTHING`;

  return memberIds.length;
}

export async function onRequest({ request, env }) {
  const secret = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  if (dryRun) {
    return json({ ok: true, message: "ready — POST with secret to run" });
  }
  try {
    await createSchema(env);
    const seeded = await seedMembers(env);
    const imported = await importHistory(env, request);
    const counts = await sql(env)`SELECT COUNT(*)::int AS n FROM picks`;
    return json({ ok: true, members_seeded: seeded, history_picks_imported: imported, total_picks_in_db: counts[0]?.n });
  } catch (e) {
    return json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
