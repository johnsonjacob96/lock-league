// Thin Neon Postgres client wrapper.
// Uses @neondatabase/serverless for edge-compatible HTTP queries.
import { neon } from "@neondatabase/serverless";

let _sql = null;
export function sql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  _sql = neon(url);
  return _sql;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  passphrase_h  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS picks (
  id            SERIAL PRIMARY KEY,
  member_id     INT NOT NULL REFERENCES members(id),
  season        INT NOT NULL,
  week          INT NOT NULL,
  bet_type      TEXT NOT NULL,   -- 'Favorite' | 'Dog' | 'Over' | 'Under' | 'Super Lock'
  pick_text     TEXT NOT NULL,
  -- Structured fields for auto-grading; nullable for Super Lock free-text
  game_key      TEXT,            -- 'AWAY@HOME' canonical
  side          TEXT,            -- 'fav' | 'dog' | 'over' | 'under'
  line          NUMERIC,         -- spread (negative) or total
  book          TEXT,            -- 'fanduel' | 'draftkings'
  price         INT,             -- american odds
  result        TEXT,            -- 'W' | 'L' | 'P' | NULL
  graded_at     TIMESTAMPTZ,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(member_id, season, week, bet_type)
);

CREATE TABLE IF NOT EXISTS games (
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
  status        TEXT DEFAULT 'scheduled', -- 'scheduled' | 'final'
  UNIQUE(season, week, away, home)
);

CREATE INDEX IF NOT EXISTS picks_season_week ON picks(season, week);
CREATE INDEX IF NOT EXISTS picks_member ON picks(member_id);
CREATE INDEX IF NOT EXISTS games_season_week ON games(season, week);
`;
