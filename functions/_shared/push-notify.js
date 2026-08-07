// Shared Web Push fan-out + idempotency helpers, usable from both the
// /api/push endpoint and the grading path (which imports from _shared only).
import { sql } from "./db.js";
import { sendPush } from "./webpush.js";

let ensured = false;
export async function ensurePushTables(env) {
  if (ensured) return;
  const s = sql(env);
  await s`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          SERIAL PRIMARY KEY,
    member_id   INT NOT NULL REFERENCES members(id),
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`;
  // One row per (season, week, kind) so a notification fires at most once even
  // though the grading cron runs several times a week.
  await s`CREATE TABLE IF NOT EXISTS week_notifications (
    season   INT NOT NULL,
    week     INT NOT NULL,
    kind     TEXT NOT NULL,
    sent_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (season, week, kind)
  )`;
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
export async function pushPersonalized(env, byMemberId) {
  await ensurePushTables(env);
  const ids = Object.keys(byMemberId).map(Number);
  if (!ids.length) return { sent: 0, failed: 0, pruned: 0 };
  const subs = await sql(env)`
    SELECT member_id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY(${ids})`;
  const items = subs
    .filter((s) => byMemberId[s.member_id])
    .map((s) => ({ sub: { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload: byMemberId[s.member_id] }));
  return deliver(env, items);
}

export async function alreadySent(env, season, week, kind) {
  await ensurePushTables(env);
  const r = await sql(env)`
    SELECT 1 FROM week_notifications WHERE season = ${season} AND week = ${week} AND kind = ${kind}`;
  return r.length > 0;
}

export async function markSent(env, season, week, kind) {
  await sql(env)`
    INSERT INTO week_notifications (season, week, kind) VALUES (${season}, ${week}, ${kind})
    ON CONFLICT (season, week, kind) DO NOTHING`;
}
