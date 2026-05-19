// Signed-cookie session for Cloudflare Pages Functions.
// HMAC-SHA256 via WebCrypto (no nodejs_compat needed).

const COOKIE = "ll_session";
const TTL_DAYS = 30;

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

export async function verifyCookie(env, cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [memberId, exp, sig] = m[1].split(".");
  if (!memberId || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  const expected = (await hmacHex(secret(env), `${memberId}.${exp}`)).slice(0, 32);
  if (expected !== sig) return null;
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
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
