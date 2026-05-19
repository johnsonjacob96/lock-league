// /api/auth?action=login|logout|me
import bcrypt from "bcryptjs";
import { sql } from "../_shared/db.js";
import { sign, verifyCookie, setCookieHeader, clearCookieHeader, json } from "../_shared/auth.js";

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (request.method === "GET" && action === "me") {
    const id = await verifyCookie(env, request.headers.get("cookie"));
    if (!id) return json({ member: null });
    const rows = await sql(env)`SELECT id, name FROM members WHERE id = ${id}`;
    return json({ member: rows[0] || null });
  }

  if (request.method === "POST" && action === "login") {
    const { name, passphrase } = await request.json().catch(() => ({}));
    if (!name || !passphrase) return json({ error: "missing" }, { status: 400 });
    const rows = await sql(env)`SELECT id, name, passphrase_h FROM members WHERE name = ${name}`;
    const m = rows[0];
    if (!m) return json({ error: "no-member" }, { status: 401 });
    const ok = await bcrypt.compare(passphrase, m.passphrase_h);
    if (!ok) return json({ error: "bad-passphrase" }, { status: 401 });
    const token = await sign(env, String(m.id));
    return json(
      { member: { id: m.id, name: m.name } },
      { headers: { "Set-Cookie": setCookieHeader(token) } }
    );
  }

  if (request.method === "POST" && action === "logout") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader() } });
  }

  return json({ error: "unknown-action" }, { status: 404 });
}
