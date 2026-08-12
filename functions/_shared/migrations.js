// Lazy, idempotent schema add-ons that layer on top of /api/init's base tables.
// Kept separate so the hot paths (pick submit, notify cron, settlement) can each
// ensure exactly what they touch without re-running the full bootstrap. Guarded
// by a per-isolate flag so it costs at most a few no-op DDLs on a cold isolate.
import { sql } from "./db.js";

let done = false;
export async function ensureExtras(env) {
  if (done) return;
  const s = sql(env);
  // Part B: last line we pushed a "better number" alert about, per pick. Reset
  // to NULL whenever the pick is re-locked, so alerts restart from the new line.
  await s`ALTER TABLE picks ADD COLUMN IF NOT EXISTS alert_line NUMERIC`;
  // Part C: each member's Venmo handle (for prefilled one-tap settlement links).
  await s`ALTER TABLE members ADD COLUMN IF NOT EXISTS venmo_handle TEXT`;
  // Props: structured Super Lock. When set, holds the picked player prop
  // {market, player, line, side, price, book, game_key} so it auto-grades off
  // the ESPN box score. NULL = a free-text Super Lock (manual Hit/Miss/Push).
  await s`ALTER TABLE picks ADD COLUMN IF NOT EXISTS prop_meta JSONB`;
  // Part C: weekly $5-to-the-winner settlement status (Article 6a). One row per
  // (season, week, member) once a week has a winner; the winner has no due.
  await s`CREATE TABLE IF NOT EXISTS weekly_dues (
    season     INT NOT NULL,
    week       INT NOT NULL,
    member_id  INT NOT NULL REFERENCES members(id),
    winner_id  INT NOT NULL REFERENCES members(id),
    amount     NUMERIC NOT NULL DEFAULT 5,
    paid       BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at    TIMESTAMPTZ,
    PRIMARY KEY (season, week, member_id)
  )`;
  // League money config. Two flows, NEITHER custodied by the app:
  //  - Season pot (Article 11: $100 entry, $500/$200/$100) is held + paid out by
  //    LeagueSafe; the app just links to it (`leaguesafe_url`) and shows the info.
  //  - Weekly game runs on Venmo, PRE-FUNDED: every member sends the collector
  //    (Jared) a season buy-in (`weekly_buyin`, $90); the collector banks it and
  //    Venmos each week's winner the weekly prize (`weekly_prize`, $40).
  //    `collector_id` = the weekly banker; `deadline` = the buy-in deadline.
  //    `entry_amount`/`payout` are the season-pot figures shown on the LeagueSafe
  //    card (display only). pot_entries tracks who has paid the weekly buy-in.
  await s`CREATE TABLE IF NOT EXISTS pot_config (
    season       INT PRIMARY KEY,
    entry_amount NUMERIC NOT NULL DEFAULT 100,
    collector_id INT REFERENCES members(id),
    deadline     TIMESTAMPTZ,
    payout       JSONB
  )`;
  await s`ALTER TABLE pot_config ADD COLUMN IF NOT EXISTS leaguesafe_url TEXT`;
  await s`ALTER TABLE pot_config ADD COLUMN IF NOT EXISTS weekly_buyin NUMERIC NOT NULL DEFAULT 90`;
  await s`ALTER TABLE pot_config ADD COLUMN IF NOT EXISTS weekly_prize NUMERIC NOT NULL DEFAULT 40`;
  await s`CREATE TABLE IF NOT EXISTS pot_entries (
    season    INT NOT NULL,
    member_id INT NOT NULL REFERENCES members(id),
    paid      BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at   TIMESTAMPTZ,
    PRIMARY KEY (season, member_id)
  )`;
  // One row per week once it has a winner: has the collector paid that week's
  // winner their weekly prize yet? (Jared -> winner, tracked so the ledger knows.)
  await s`CREATE TABLE IF NOT EXISTS weekly_payouts (
    season   INT NOT NULL,
    week     INT NOT NULL,
    paid     BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at  TIMESTAMPTZ,
    PRIMARY KEY (season, week)
  )`;
  done = true;
}
