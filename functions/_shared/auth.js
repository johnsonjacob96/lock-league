// Signed-cookie session for Cloudflare Pages Functions.
// HMAC-SHA256 via WebCrypto (no nodejs_compat needed).
//
// The cookie carries the member's session epoch alongside their id, and every
// request checks it against the row. Bumping members.session_epoch (on a reset
// or a password change) therefore invalidates every cookie already handed out
// for that member — the point of a reset after a lost or shared password.
import { sql } from "./db.js";

const COOKIE = "ll_session";
const TTL_DAYS = 30;
// One epoch read per member per isolate per minute, rather than per request.
// The cost is that a revocation can take up to this long to reach an isolate
// that already looked the member up.
const EPOCH_TTL_MS = 60_000;
const epochCache = new Map();

async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function secret(env) {
  const s = env?.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

export async function sign(env, payload) {
  const exp = Date.now() + TTL_DAYS * 24 * 3600 * 1000;
  const body = `${payload}.${exp}`;
  const sig = (await hmacHex(secret(env), body)).slice(0, 32);
  return `${body}.${sig}`;
}

// Current epoch for a member, or null if the member no longer exists.
export async function sessionEpoch(env, memberId) {
  const hit = epochCache.get(memberId);
  if (hit && Date.now() - hit.ts < EPOCH_TTL_MS) return hit.epoch;
  let epoch = 0;
  try {
    const rows = await sql(env)`SELECT session_epoch FROM members WHERE id = ${memberId}`;
    if (!rows.length) return null;
    epoch = Number(rows[0].session_epoch) || 0;
  } catch (e) {
    // On a database that hasn't run ensureExtras yet the column is missing and
    // every member is still at epoch 0 — read it as 0 rather than signing the
    // whole league out. Any other database error is a real failure.
    if (e?.code !== "42703") throw e;
  }
  epochCache.set(memberId, { ts: Date.now(), epoch });
  return epoch;
}

// Invalidates every cookie previously issued for this member. Returns the new epoch.
export async function bumpSessionEpoch(env, memberId) {
  const rows = await sql(env)`
    UPDATE members SET session_epoch = COALESCE(session_epoch, 0) + 1
    WHERE id = ${memberId} RETURNING session_epoch`;
  const epoch = Number(rows[0]?.session_epoch) || 0;
  epochCache.set(memberId, { ts: Date.now(), epoch });
  return epoch;
}

// Set-Cookie value for a freshly signed session at the member's current epoch.
export async function issueSession(env, memberId) {
  const epoch = (await sessionEpoch(env, memberId)) ?? 0;
  return setCookieHeader(await sign(env, `${memberId}.${epoch}`));
}

export async function verifyCookie(env, cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");
  // Cookies signed before epochs existed carry no epoch field; they are epoch 0,
  // so a reset revokes them too.
  const [memberId, epoch, exp, sig] = parts.length === 4 ? parts : [parts[0], "0", parts[1], parts[2]];
  if (!memberId || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  const body = parts.length === 4 ? `${memberId}.${epoch}.${exp}` : `${memberId}.${exp}`;
  const expected = (await hmacHex(secret(env), body)).slice(0, 32);
  if (expected !== sig) return null;
  let current;
  try { current = await sessionEpoch(env, Number(memberId)); } catch { return null; }
  if (current === null || current !== Number(epoch)) return null;
  return Number(memberId);
}

export function setCookieHeader(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${TTL_DAYS * 24 * 3600}`;
}

export function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}
