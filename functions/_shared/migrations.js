// Lazy, idempotent schema add-ons that layer on top of /api/init's base tables.
// Kept separate so the hot paths (pick submit, notify cron, settlement) can each
// ensure exactly what they touch without re-running the full bootstrap. Guarded
// by a per-isolate flag so it costs at most a few no-op DDLs on a cold isolate.
import { sql, ignoringConcurrentCreate } from "./db.js";

let done = false;
export async function ensureExtras(env) {
  if (done) return;
  const s = sql(env);
  // Part B: last line we pushed a "better number" alert about, per pick. Reset
  // to NULL whenever the pick is re-locked, so alerts restart from the new line.
  await ignoringConcurrentCreate(s`ALTER TABLE picks ADD COLUMN IF NOT EXISTS alert_line NUMERIC`);
  // Part C: each member's Venmo handle (for prefilled one-tap settlement links).
  await ignoringConcurrentCreate(s`ALTER TABLE members ADD COLUMN IF NOT EXISTS venmo_handle TEXT`);
  // Per-category push preferences. NULL/missing key = on (opt-out, not opt-in),
  // so existing subscribers keep getting everything until they turn a category off.
  await ignoringConcurrentCreate(s`ALTER TABLE members ADD COLUMN IF NOT EXISTS notif_prefs JSONB`);
  // Password recovery. is_admin marks the commissioner(s) who can issue a reset
  // code for another member; session_epoch is bumped whenever a password changes
  // so every cookie signed before the change stops verifying.
  await ignoringConcurrentCreate(s`ALTER TABLE members ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`);
  await ignoringConcurrentCreate(s`ALTER TABLE members ADD COLUMN IF NOT EXISTS session_epoch INT NOT NULL DEFAULT 0`);
  // One-time reset codes. Only the bcrypt hash is stored, so a database dump
  // does not hand over live codes; attempts caps guessing at a handful of tries.
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS password_resets (
    id         SERIAL PRIMARY KEY,
    member_id  INT NOT NULL REFERENCES members(id),
    code_h     TEXT NOT NULL,
    channel    TEXT,
    issued_by  INT REFERENCES members(id),
    attempts   INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await ignoringConcurrentCreate(s`CREATE INDEX IF NOT EXISTS password_resets_member ON password_resets(member_id, created_at DESC)`);
  // Props: structured Super Lock. When set, holds the picked player prop
  // {market, player, line, side, price, book, game_key} so it auto-grades off
  // the ESPN box score. NULL = a free-text Super Lock (manual Hit/Miss/Push).
  await ignoringConcurrentCreate(s`ALTER TABLE picks ADD COLUMN IF NOT EXISTS prop_meta JSONB`);
  // Part C: weekly $5-to-the-winner settlement status (Article 6a). One row per
  // (season, week, member) once a week has a winner; the winner has no due.
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS weekly_dues (
    season     INT NOT NULL,
    week       INT NOT NULL,
    member_id  INT NOT NULL REFERENCES members(id),
    winner_id  INT NOT NULL REFERENCES members(id),
    amount     NUMERIC NOT NULL DEFAULT 5,
    paid       BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at    TIMESTAMPTZ,
    PRIMARY KEY (season, week, member_id)
  )`);
  // Both funds use Venmo through the collector. Weekly and season entries stay separate.
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS pot_config (
    season       INT PRIMARY KEY,
    entry_amount NUMERIC NOT NULL DEFAULT 100,
    collector_id INT REFERENCES members(id),
    deadline     TIMESTAMPTZ,
    payout       JSONB
  )`);
  await ignoringConcurrentCreate(s`ALTER TABLE pot_config ADD COLUMN IF NOT EXISTS weekly_buyin NUMERIC NOT NULL DEFAULT 90`);
  await ignoringConcurrentCreate(s`ALTER TABLE pot_config ADD COLUMN IF NOT EXISTS weekly_prize NUMERIC NOT NULL DEFAULT 40`);
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS pot_entries (
    season    INT NOT NULL,
    member_id INT NOT NULL REFERENCES members(id),
    paid      BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at   TIMESTAMPTZ,
    PRIMARY KEY (season, member_id)
  )`);
  // One row per week once it has a winner: has the collector paid that week's
  // winner their weekly prize yet? (Jared -> winner, tracked so the ledger knows.)
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS weekly_payouts (
    season   INT NOT NULL,
    week     INT NOT NULL,
    paid     BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at  TIMESTAMPTZ,
    PRIMARY KEY (season, week)
  )`);
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS season_entries (
    season INT NOT NULL, member_id INT NOT NULL REFERENCES members(id),
    paid BOOLEAN NOT NULL DEFAULT FALSE, paid_at TIMESTAMPTZ,
    PRIMARY KEY (season, member_id)
  )`);
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS season_payouts (
    season INT NOT NULL, place INT NOT NULL,
    member_id INT NOT NULL REFERENCES members(id), amount NUMERIC NOT NULL,
    paid BOOLEAN NOT NULL DEFAULT FALSE, paid_at TIMESTAMPTZ,
    PRIMARY KEY (season, place), UNIQUE (season, member_id)
  )`);
  done = true;
}
