// Shared Web Push fan-out + idempotency helpers, usable from both the
// /api/push endpoint and the grading path (which imports from _shared only).
import { sql, ignoringConcurrentCreate } from "./db.js";
import { sendPush } from "./webpush.js";
import { ensureExtras } from "./migrations.js";

let ensured = false;
export async function ensurePushTables(env) {
  if (ensured) return;
  const s = sql(env);
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          SERIAL PRIMARY KEY,
    member_id   INT NOT NULL REFERENCES members(id),
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  // One row per (season, week, kind) so a notification fires at most once even
  // though the grading cron runs several times a week.
  await ignoringConcurrentCreate(s`CREATE TABLE IF NOT EXISTS week_notifications (
    season   INT NOT NULL,
    week     INT NOT NULL,
    kind     TEXT NOT NULL,
    sent_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, week, kind)
  )`);
  ensured = true;
}

// items: [{ sub:{endpoint,p256dh,auth}, payload }]. Sends all, prunes dead subs.
async function deliver(env, items) {
  const dead = [];
  let sent = 0, failed = 0;
  const results = await Promise.allSettled(items.map((it) => sendPush(it.sub, it.payload, env)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ok) sent++;
    else {
      failed++;
      const code = r.status === "fulfilled" ? r.value.status : 0;
      if (code === 404 || code === 410) dead.push(items[i].sub.endpoint);
    }
  });
  if (dead.length) await sql(env)`DELETE FROM push_subscriptions WHERE endpoint = ANY(${dead})`.catch(() => {});
  return { sent, failed, pruned: dead.length };
}

// Same payload to every subscription belonging to memberIds.
export async function pushToMembers(env, memberIds, payload) {
  await ensurePushTables(env);
  if (!memberIds?.length) return { sent: 0, failed: 0, pruned: 0 };
  const subs = await sql(env)`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY(${memberIds})`;
  return deliver(env, subs.map((sub) => ({ sub, payload })));
}

// Personalized payload per member. byMemberId: { [memberId]: payloadObject }.
// `kind` (e.g. "lineMoves"/"reminder"/"results") gates delivery on that member's
// notif_prefs — a category defaults ON when the member has never touched it
// (opt-out, not opt-in), so pass a kind whenever the caller has a category to
// check; omit it only for pushes that should always go through (e.g. a test ping).
export async function pushPersonalized(env, byMemberId, kind = null) {
  await ensurePushTables(env);
  if (kind) await ensureExtras(env); // notif_prefs column
  const ids = Object.keys(byMemberId).map(Number);
  if (!ids.length) return { sent: 0, failed: 0, pruned: 0 };
  const subs = await sql(env)`
    SELECT s.member_id, s.endpoint, s.p256dh, s.auth, m.notif_prefs
    FROM push_subscriptions s JOIN members m ON m.id = s.member_id
    WHERE s.member_id = ANY(${ids})`;
  const items = subs
    .filter((s) => byMemberId[s.member_id])
    .filter((s) => !kind || s.notif_prefs?.[kind] !== false)
    .map((s) => ({ sub: { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload: byMemberId[s.member_id] }));
  return deliver(env, items);
}

// Atomically claims the (season, week, kind) send slot: true if this call is
// the one that gets to send (first isolate wins), false if another isolate
// already claimed/sent it. A single INSERT ... ON CONFLICT DO NOTHING is
// race-safe across concurrent isolates in a way a separate check-then-act
// SELECT + INSERT pair is not — callers must call this immediately before
// sending, not at the top of a function that can bail out early for other
// reasons (a bail before this call must not consume the slot).
export async function claimSend(env, season, week, kind) {
  await ensurePushTables(env);
  const r = await sql(env)`
    INSERT INTO week_notifications (season, week, kind) VALUES (${season}, ${week}, ${kind})
    ON CONFLICT (season, week, kind) DO NOTHING
    RETURNING season`;
  return r.length > 0;
}
