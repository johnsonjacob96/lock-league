// /api/push — manage a member's Web Push subscriptions.
//   GET                      -> { vapidPublic, subscribed, prefs }  (member must be logged in)
//   POST ?action=subscribe   body { endpoint, keys:{p256dh,auth} } -> saves subscription
//   POST ?action=unsubscribe body { endpoint }                     -> removes subscription
//   POST ?action=prefs       body { lineMoves?, reminder?, results? } (bool) -> merges into notif_prefs
//   POST ?action=test        -> sends a test push to this member's devices
import { sql } from "../_shared/db.js";
import { verifyCookie, json } from "../_shared/auth.js";
import { ensurePushTables, pushToMembers } from "../_shared/push-notify.js";
import { ensureExtras } from "../_shared/migrations.js";

const PREF_KEYS = ["lineMoves", "reminder", "results"];
// Missing/NULL key = on (opt-out default), so pre-existing subscribers keep
// getting everything until they explicitly flip a category off.
const defaultPrefs = () => Object.fromEntries(PREF_KEYS.map((k) => [k, true]));

export async function onRequest({ request, env }) {
  const memberId = await verifyCookie(env, request.headers.get("cookie"));
  if (!memberId) return json({ error: "not-authenticated" }, { status: 401 });
  await ensurePushTables(env);
  await ensureExtras(env);
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!env.VAPID_PUBLIC) return json({ error: "push-not-configured" }, { status: 503 });
    const rows = await sql(env)`
      SELECT
        (SELECT COUNT(*) FROM push_subscriptions WHERE member_id = ${memberId})::int AS n,
        notif_prefs
      FROM members WHERE id = ${memberId}`;
    const prefs = { ...defaultPrefs(), ...(rows[0]?.notif_prefs || {}) };
    return json({ vapidPublic: env.VAPID_PUBLIC, subscribed: (rows[0]?.n || 0) > 0, prefs });
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

    if (action === "prefs") {
      const patch = {};
      for (const k of PREF_KEYS) if (typeof bodyIn?.[k] === "boolean") patch[k] = bodyIn[k];
      if (!Object.keys(patch).length) return json({ error: "no-valid-prefs" }, { status: 400 });
      const rows = await sql(env)`SELECT notif_prefs FROM members WHERE id = ${memberId}`;
      const merged = { ...defaultPrefs(), ...(rows[0]?.notif_prefs || {}), ...patch };
      await sql(env)`UPDATE members SET notif_prefs = ${JSON.stringify(merged)}::jsonb WHERE id = ${memberId}`;
      return json({ ok: true, prefs: merged });
    }

    if (action === "test") {
      const res = await pushToMembers(env, [memberId], {
        title: "Lock League",
        body: "Notifications are on. This is a test.",
        url: "/",
        tag: "ll-test",
      });
      return json({ ok: true, ...res });
    }

    return json({ error: "unknown-action" }, { status: 400 });
  }

  return json({ error: "method-not-allowed" }, { status: 405 });
}
