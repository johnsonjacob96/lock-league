// One-time bootstrap:
//   1. Creates schema
//   2. Seeds 8 members with throwaway passphrases (overwrite later via UI or env)
//   3. Optionally imports historical seasons.json into picks (for live-season standings only)
//
// Run with:
//   DATABASE_URL=... node scripts/init-db.js seed
//   DATABASE_URL=... node scripts/init-db.js import-history

import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const sql = neon(process.env.DATABASE_URL);

const MEMBERS = ["Brayden", "Chase", "Chris", "Jack", "Jacob", "Jared", "Mason", "Tyler"];

async function createSchema() {
  await sql`CREATE TABLE IF NOT EXISTS members (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    passphrase_h  TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS picks (
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
  await sql`CREATE TABLE IF NOT EXISTS games (
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
  await sql`CREATE INDEX IF NOT EXISTS picks_season_week ON picks(season, week)`;
  await sql`CREATE INDEX IF NOT EXISTS picks_member ON picks(member_id)`;
  await sql`CREATE INDEX IF NOT EXISTS games_season_week ON games(season, week)`;
  console.log("schema created");
}

async function seedMembers() {
  for (const name of MEMBERS) {
    const passphrase = name.toLowerCase() + "2026";
    const hash = await bcrypt.hash(passphrase, 10);
    await sql`
      INSERT INTO members (name, passphrase_h)
      VALUES (${name}, ${hash})
      ON CONFLICT (name) DO NOTHING`;
    console.log(`  seeded ${name}  (initial passphrase: ${passphrase})`);
  }
}

async function importHistory() {
  const p = path.join(process.cwd(), "data", "seasons.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  let inserted = 0;
  for (const [memberName, years] of Object.entries(data.members || {})) {
    const memRow = await sql`SELECT id FROM members WHERE name = ${memberName}`;
    const memId = memRow[0]?.id;
    if (!memId) { console.warn(`skip ${memberName}: not in members`); continue; }
    for (const [year, info] of Object.entries(years)) {
      for (const [bt, btInfo] of Object.entries(info.byType || {})) {
        for (const [wk, pick] of Object.entries(btInfo.picks || {})) {
          await sql`
            INSERT INTO picks (member_id, season, week, bet_type, pick_text, result)
            VALUES (${memId}, ${Number(year)}, ${Number(wk)}, ${bt}, ${pick.text || ""}, ${pick.result || null})
            ON CONFLICT (member_id, season, week, bet_type) DO NOTHING`;
          inserted++;
        }
      }
    }
  }
  console.log(`imported ${inserted} historical picks`);
}

const cmd = process.argv[2];
if (cmd === "schema") await createSchema();
else if (cmd === "seed") { await createSchema(); await seedMembers(); }
else if (cmd === "import-history") await importHistory();
else if (cmd === "all") { await createSchema(); await seedMembers(); await importHistory(); }
else {
  console.log("usage: node scripts/init-db.js {schema|seed|import-history|all}");
  process.exit(1);
}
