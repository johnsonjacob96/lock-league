// /api/auth?action=login|logout|me
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "../../lib/db.js";

const COOKIE = "ll_session";
const TTL_DAYS = 30;

function secret() {
  const s = Netlify.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}
function sign(payload) {
  const exp = Date.now() + TTL_DAYS * 24 * 3600 * 1000;
  const body = `${payload}.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("hex").slice(0, 32);
  return `${body}.${sig}`;
}
export function verifyCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [memberId, exp, sig] = m[1].split(".");
  if (!memberId || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  const expected = crypto.createHmac("sha256", secret()).update(`${memberId}.${exp}`).digest("hex").slice(0, 32);
  if (expected !== sig) return null;
  return Number(memberId);
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (req.method === "GET" && action === "me") {
    const id = verifyCookie(req.headers.get("cookie"));
    if (!id) return json({ member: null });
    const rows = await sql()`SELECT id, name FROM members WHERE id = ${id}`;
    return json({ member: rows[0] || null });
  }

  if (req.method === "POST" && action === "login") {
    const { name, passphrase } = await req.json().catch(() => ({}));
    if (!name || !passphrase) return json({ error: "missing" }, { status: 400 });
    const rows = await sql()`SELECT id, name, passphrase_h FROM members WHERE name = ${name}`;
    const m = rows[0];
    if (!m) return json({ error: "no-member" }, { status: 401 });
    const ok = await bcrypt.compare(passphrase, m.passphrase_h);
    if (!ok) return json({ error: "bad-passphrase" }, { status: 401 });
    const token = sign(String(m.id));
    return json(
      { member: { id: m.id, name: m.name } },
      { headers: { "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${TTL_DAYS * 24 * 3600}` } }
    );
  }

  if (req.method === "POST" && action === "logout") {
    return json(
      { ok: true },
      { headers: { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0` } }
    );
  }

  return json({ error: "unknown-action" }, { status: 404 });
};
