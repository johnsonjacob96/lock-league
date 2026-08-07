// /api/push — manage a member's Web Push subscriptions.
//   GET                      -> { vapidPublic, subscribed }  (member must be logged in)
//   POST ?action=subscribe   body { endpoint, keys:{p256dh,auth} } -> saves subscription
//   POST ?action=unsubscribe body { endpoint }                     -> removes subscription
//   POST ?action=test        -> sends a test push to this member's devices
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { sendPush } from "../_shared/webpush.js";

let ensured = false;
async function ensureTable(env) {
  if (ensured) return;
  await sql(env)`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          SERIAL PRIMARY KEY,
    member_id   INT NOT NULL REFERENCES members(id),
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`;
  ensured = true;
}

// Prune subscriptions the push service reports as gone (404/410).
export async function pruneDead(env, endpoints) {
  if (!endpoints.length) return;
  await sql(env)`DELETE FROM push_subscriptions WHERE endpoint = ANY(${endpoints})`;
}

// Send a payload to every subscription for a set of member ids. Prunes dead ones.
export async function pushToMembers(env, memberIds, payload) {
  await ensureTable(env);
  if (!memberIds?.length) return { sent: 0, failed: 0 };
  const subs = await sql(env)`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ANY(${memberIds})`;
  return deliver(env, subs, payload);
}

async function deliver(env, subs, payload) {
  const dead = [];
  let sent = 0, failed = 0;
  const results = await Promise.allSettled(subs.map((s) => sendPush(s, payload, env)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ok) sent++;
    else {
      failed++;
      const code = r.status === "fulfilled" ? r.value.status : 0;
      if (code === 404 || code === 410) dead.push(subs[i].endpoint);
    }
  });
  await pruneDead(env, dead).catch(() => {});
  return { sent, failed, pruned: dead.length };
}

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
  await ensureTable(env);
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!env.VAPID_PUBLIC) return json({ error: "push-not-configured" }, { status: 503 });
    const rows = await sql(env)`
      SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE member_id = ${memberId}`;
    return json({ vapidPublic: env.VAPID_PUBLIC, subscribed: (rows[0]?.n || 0) > 0 });
  }

  if (request.method === "POST") {
    const action = url.searchParams.get("action");
    const bodyIn = await request.json().catch(() => ({}));

    if (action === "subscribe") {
      const { endpoint, keys } = bodyIn || {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return json({ error: "bad-subscription" }, { status: 400 });
      }
      await sql(env)`
        INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth)
        VALUES (${memberId}, ${endpoint}, ${keys.p256dh}, ${keys.auth})
        ON CONFLICT (endpoint)
        DO UPDATE SET member_id = ${memberId}, p256dh = ${keys.p256dh}, auth = ${keys.auth}`;
      return json({ ok: true, subscribed: true });
    }

    if (action === "unsubscribe") {
      const { endpoint } = bodyIn || {};
      if (endpoint) {
        await sql(env)`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND member_id = ${memberId}`;
      }
      return json({ ok: true, subscribed: false });
    }

    if (action === "test") {
      const res = await pushToMembers(env, [memberId], {
        title: "Lock League",
        body: "Notifications are on. This is a test. 🔒",
        url: "/",
        tag: "ll-test",
      });
      return json({ ok: true, ...res });
    }

    return json({ error: "unknown-action" }, { status: 400 });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
