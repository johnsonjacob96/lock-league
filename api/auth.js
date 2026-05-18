// /api/auth — login / logout for members.
// Session model: signed cookie "ll_session" = "memberId.signedExpiry"
// Simple HMAC, no JWT lib needed.

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "../lib/db.js";

const COOKIE = "ll_session";
const TTL_DAYS = 30;

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}
function sign(payload) {
  const exp = Date.now() + TTL_DAYS * 24 * 3600 * 1000;
  const body = `${payload}.${exp}`;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("hex").slice(0, 32);
  return `${body}.${sig}`;
}
export function verifyCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [memberId, exp, sig] = m[1].split(".");
  if (!memberId || !exp || !sig) return null;
  if (Date.now() > Number(exp)) return null;
  const expected = crypto
    .createHmac("sha256", sessionSecret())
    .update(`${memberId}.${exp}`)
    .digest("hex")
    .slice(0, 32);
  if (expected !== sig) return null;
  return Number(memberId);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try { resolve(JSON.parse(chunks || "{}")); } catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  const action = (req.query.action || "").toLowerCase();
  if (req.method === "GET" && action === "me") {
    const id = verifyCookie(req.headers.cookie);
    if (!id) return res.status(200).json({ member: null });
    const rows = await sql()`SELECT id, name FROM members WHERE id = ${id}`;
    return res.status(200).json({ member: rows[0] || null });
  }
  if (req.method === "POST" && action === "login") {
    const { name, passphrase } = await readBody(req);
    if (!name || !passphrase) return res.status(400).json({ error: "missing" });
    const rows = await sql()`SELECT id, name, passphrase_h FROM members WHERE name = ${name}`;
    const m = rows[0];
    if (!m) return res.status(401).json({ error: "no-member" });
    const ok = await bcrypt.compare(passphrase, m.passphrase_h);
    if (!ok) return res.status(401).json({ error: "bad-passphrase" });
    const token = sign(String(m.id));
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_DAYS * 24 * 3600}`
    );
    return res.status(200).json({ member: { id: m.id, name: m.name } });
  }
  if (req.method === "POST" && action === "logout") {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res.status(200).json({ ok: true });
  }
  return res.status(404).json({ error: "unknown-action" });
}
