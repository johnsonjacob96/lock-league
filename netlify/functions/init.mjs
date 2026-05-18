// /api/_init — one-shot DB bootstrap.
// Creates schema, seeds members with starter passphrases, imports historical
// picks from data/seasons.json. Idempotent: safe to re-run.
//
// Auth: X-Cron-Secret header must match CRON_SECRET env var.

import bcrypt from "bcryptjs";
import { sql } from "../../lib/db.js";

// Embed the historical data so we don't need filesystem access at runtime.
// Netlify's esbuild bundler will inline this import.
import historicalData from "../../data/seasons.json" with { type: "json" };

const MEMBERS = ["Brayden", "Chase", "Chris", "Jack", "Jacob", "Jared", "Mason", "Tyler"];

async function createSchema() {
  const s = sql();
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

async function seedMembers() {
  const seeded = [];
  for (const name of MEMBERS) {
    const passphrase = name.toLowerCase() + "2026";
    const hash = await bcrypt.hash(passphrase, 10);
    await sql()`
      INSERT INTO members (name, passphrase_h)
      VALUES (${name}, ${hash})
      ON CONFLICT (name) DO NOTHING`;
    seeded.push({ name, initial_passphrase: passphrase });
  }
  return seeded;
}

async function importHistory() {
  const s = sql();
  // Resolve all member ids in one query
  const memRows = await s`SELECT id, name FROM members`;
  const memIdByName = Object.fromEntries(memRows.map(r => [r.name, r.id]));

  // Collect every row to insert
  const rows = [];
  for (const [memberName, years] of Object.entries(historicalData.members || {})) {
    const memId = memIdByName[memberName];
    if (!memId) continue;
    for (const [year, info] of Object.entries(years)) {
      for (const [bt, btInfo] of Object.entries(info.byType || {})) {
        for (const [wk, pick] of Object.entries(btInfo.picks || {})) {
          rows.push([memId, Number(year), Number(wk), bt, pick.text || "", pick.result || null]);
        }
      }
    }
  }

  // Bulk insert in chunks of 500
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map((_, idx) => {
        const off = idx * 6;
        return `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6})`;
      })
      .join(",");
    const params = chunk.flat();
    const text = `INSERT INTO picks (member_id, season, week, bet_type, pick_text, result)
                  VALUES ${placeholders}
                  ON CONFLICT (member_id, season, week, bet_type) DO NOTHING`;
    await s.query(text, params);
    inserted += chunk.length;
  }
  return inserted;
}

export default async (req) => {
  const secret = req.headers.get("x-cron-secret");
  const cronSecret = Netlify.env.get("CRON_SECRET");
  if (!cronSecret || secret !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("env") === "1") {
    const dbKeys = Object.keys(process.env)
      .filter(k => /DATABASE|POSTGRES|NEON|NETLIFY_DB/i.test(k));
    return new Response(JSON.stringify({ ok: true, db_env_keys_seen: dbKeys }), { headers: { "Content-Type": "application/json" } });
  }
  const dryRun = url.searchParams.get("dry") === "1";
  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, message: "ready — POST with secret to run" }), { headers: { "Content-Type": "application/json" } });
  }
  try {
    await createSchema();
    const seeded = await seedMembers();
    const imported = await importHistory();
    const counts = await sql()`SELECT COUNT(*)::int AS n FROM picks`;
    return new Response(
      JSON.stringify({ ok: true, members_seeded: seeded, history_picks_imported: imported, total_picks_in_db: counts[0]?.n }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
