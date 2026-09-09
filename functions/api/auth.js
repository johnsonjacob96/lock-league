// /api/auth?action=login|logout|me|change-pass|reset-request|reset-issue|reset-confirm|set-admin
//
// Password recovery (no email provider, no stored addresses): a member asks for
// a code, it is pushed to the devices they already registered for
// notifications. A member with no registered device asks a commissioner, who
// issues the same kind of code from the app and relays it. The commissioner
// recovers themselves with CRON_SECRET, which is Cloudflare-side only.
import bcrypt from "bcryptjs";
import { sql } from "../_shared/db.js";
import { ensureExtras } from "../_shared/migrations.js";
import { pushToMembers, ensurePushTables } from "../_shared/push-notify.js";
import { verifyCookie, clearCookieHeader, issueSession, bumpSessionEpoch, json } from "../_shared/auth.js";

const CODE_TTL_MIN = 20;
const CODE_COOLDOWN_S = 60;
const MAX_ATTEMPTS = 5;
// No I/O/0/1: these get read aloud and typed on a phone.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// Codes are relayed by voice and text, so accept whatever punctuation and case
// they come back in.
const normalize = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function memberByName(env, name) {
  if (typeof name !== "string" || !name) return null;
  const rows = await sql(env)`SELECT id, name FROM members WHERE name = ${name}`;
  return rows[0] || null;
}

async function issueCode(env, memberId, channel, issuedBy = null) {
  const code = newCode();
  const code_h = await bcrypt.hash(normalize(code), 10);
  await sql(env)`
    INSERT INTO password_resets (member_id, code_h, channel, issued_by, expires_at)
    VALUES (${memberId}, ${code_h}, ${channel}, ${issuedBy},
            NOW() + (${CODE_TTL_MIN} || ' minutes')::interval)`;
  return code;
}

// True if a code was issued for this member within the cooldown, so a repeated
// tap on "send me a code" can't fan out a burst of notifications.
async function issuedRecently(env, memberId) {
  const rows = await sql(env)`
    SELECT 1 FROM password_resets
    WHERE member_id = ${memberId}
      AND created_at > NOW() - (${CODE_COOLDOWN_S} || ' seconds')::interval
    LIMIT 1`;
  return rows.length > 0;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) || {}) : {};

  if (request.method === "GET" && action === "me") {
    const id = await verifyCookie(env, request.headers.get("cookie"));
    if (!id) return json({ member: null });
    // is_admin arrives with ensureExtras; fall back until it has run.
    let rows;
    try {
      rows = await sql(env)`SELECT id, name, is_admin FROM members WHERE id = ${id}`;
    } catch (e) {
      if (e?.code !== "42703") throw e;
      rows = await sql(env)`SELECT id, name FROM members WHERE id = ${id}`;
    }
    return json({ member: rows[0] || null });
  }

  if (request.method === "POST" && action === "login") {
    const { name, passphrase } = body;
    if (typeof name !== "string" || typeof passphrase !== "string" || !name || !passphrase) return json({ error: "missing" }, { status: 400 });
    const rows = await sql(env)`SELECT id, name, passphrase_h FROM members WHERE name = ${name}`;
    const m = rows[0];
    if (!m) return json({ error: "no-member" }, { status: 401 });
    const ok = await bcrypt.compare(passphrase, m.passphrase_h);
    if (!ok) return json({ error: "bad-passphrase" }, { status: 401 });
    return json(
      { member: { id: m.id, name: m.name } },
      { headers: { "Set-Cookie": await issueSession(env, m.id) } }
    );
  }

  if (request.method === "POST" && action === "logout") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader() } });
  }

  if (request.method === "POST" && action === "change-pass") {
    const id = await verifyCookie(env, request.headers.get("cookie"));
    if (!id) return json({ error: "not-authenticated" }, { status: 401 });
    const { current, next } = body;
    if (typeof current !== "string" || typeof next !== "string" || !current || !next) return json({ error: "missing" }, { status: 400 });
    if (String(next).length < 8) return json({ error: "too-short", min: 8 }, { status: 400 });
    const rows = await sql(env)`SELECT id, passphrase_h FROM members WHERE id = ${id}`;
    const m = rows[0];
    if (!m) return json({ error: "no-member" }, { status: 401 });
    const ok = await bcrypt.compare(current, m.passphrase_h);
    if (!ok) return json({ error: "bad-passphrase" }, { status: 401 });
    const hash = await bcrypt.hash(next, 10);
    await sql(env)`UPDATE members SET passphrase_h = ${hash} WHERE id = ${id}`;
    // Changing the password signs out every other device, and re-issues this one.
    await ensureExtras(env);
    await bumpSessionEpoch(env, id);
    return json({ ok: true }, { headers: { "Set-Cookie": await issueSession(env, id) } });
  }

  // Member-initiated: send a code to the devices this member already registered
  // for push. Nothing here reveals more than the sign-in menu already does —
  // the member list is public within the league.
  if (request.method === "POST" && action === "reset-request") {
    await ensureExtras(env);
    await ensurePushTables(env);
    const m = await memberByName(env, body.name);
    if (!m) return json({ error: "no-member" }, { status: 404 });
    const devices = await sql(env)`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE member_id = ${m.id}`;
    if (!devices[0]?.n) return json({ ok: true, channel: "none" });
    if (await issuedRecently(env, m.id)) return json({ error: "too-soon", retry_after: CODE_COOLDOWN_S }, { status: 429 });
    const code = await issueCode(env, m.id, "push");
    const sent = await pushToMembers(env, [m.id], {
      title: "Lock League password reset",
      body: `Your code is ${code}. It expires in ${CODE_TTL_MIN} minutes.`,
      tag: "password-reset",
      url: "/",
    });
    if (!sent.sent) return json({ ok: true, channel: "none" });
    return json({ ok: true, channel: "push", devices: sent.sent, expires_in_minutes: CODE_TTL_MIN });
  }

  // Commissioner-initiated: returns the code once, in the clear, for the
  // commissioner to relay. CRON_SECRET works too, so the commissioner has a way
  // back in when it is their own password that is lost.
  if (request.method === "POST" && action === "reset-issue") {
    await ensureExtras(env);
    const viaSecret = !!env.CRON_SECRET && request.headers.get("X-Cron-Secret") === env.CRON_SECRET;
    let issuedBy = null;
    if (!viaSecret) {
      const id = await verifyCookie(env, request.headers.get("cookie"));
      if (!id) return json({ error: "not-authenticated" }, { status: 401 });
      const rows = await sql(env)`SELECT is_admin FROM members WHERE id = ${id}`;
      if (!rows[0]?.is_admin) return json({ error: "not-admin" }, { status: 403 });
      issuedBy = id;
    }
    const m = await memberByName(env, body.name);
    if (!m) return json({ error: "no-member" }, { status: 404 });
    const code = await issueCode(env, m.id, viaSecret ? "secret" : "admin", issuedBy);
    return json({ ok: true, member: { id: m.id, name: m.name }, code, expires_in_minutes: CODE_TTL_MIN });
  }

  // Redeem a code from either channel: sets the new password, burns every
  // outstanding code, signs out every other device, and signs this one in.
  if (request.method === "POST" && action === "reset-confirm") {
    await ensureExtras(env);
    const { code, next } = body;
    if (typeof code !== "string" || typeof next !== "string" || !code || !next) return json({ error: "missing" }, { status: 400 });
    if (next.length < 8) return json({ error: "too-short", min: 8 }, { status: 400 });
    const m = await memberByName(env, body.name);
    if (!m) return json({ error: "no-member" }, { status: 404 });
    const rows = await sql(env)`
      SELECT id, code_h, attempts FROM password_resets
      WHERE member_id = ${m.id} AND used_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC, id DESC LIMIT 1`;
    const r = rows[0];
    if (!r) return json({ error: "no-code" }, { status: 400 });
    if (r.attempts >= MAX_ATTEMPTS) return json({ error: "too-many" }, { status: 429 });
    if (!(await bcrypt.compare(normalize(code), r.code_h))) {
      await sql(env)`UPDATE password_resets SET attempts = attempts + 1 WHERE id = ${r.id}`;
      return json({ error: "bad-code", attempts_left: MAX_ATTEMPTS - (r.attempts + 1) }, { status: 401 });
    }
    const hash = await bcrypt.hash(next, 10);
    await sql(env)`UPDATE members SET passphrase_h = ${hash} WHERE id = ${m.id}`;
    await sql(env)`UPDATE password_resets SET used_at = NOW() WHERE member_id = ${m.id} AND used_at IS NULL`;
    await bumpSessionEpoch(env, m.id);
    return json(
      { member: { id: m.id, name: m.name } },
      { headers: { "Set-Cookie": await issueSession(env, m.id) } }
    );
  }

  // Bootstrap/transfer the commissioner role. CRON_SECRET only: there is no
  // in-app path to grant it, so a stolen session can't promote itself.
  if (request.method === "POST" && action === "set-admin") {
    if (!env.CRON_SECRET || request.headers.get("X-Cron-Secret") !== env.CRON_SECRET) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    await ensureExtras(env);
    const m = await memberByName(env, body.name);
    if (!m) return json({ error: "no-member" }, { status: 404 });
    const admin = body.admin !== false;
    await sql(env)`UPDATE members SET is_admin = ${admin} WHERE id = ${m.id}`;
    return json({ ok: true, member: { id: m.id, name: m.name }, is_admin: admin });
  }

  return json({ error: "unknown-action" }, { status: 404 });
}
