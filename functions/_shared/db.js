// Thin Neon Postgres client wrapper for Cloudflare Pages Functions.
// Pass `env` from the Pages Functions context.
import { neon } from "@neondatabase/serverless";

export function sql(env) {
  const url =
    env?.DATABASE_URL ||
    env?.POSTGRES_URL ||
    env?.NEON_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in env");
  return neon(url);
}

// Postgres' CREATE TABLE/ALTER TABLE ... IF NOT EXISTS isn't atomic against a
// concurrent creator, so two cold isolates racing on the same DDL after a
// deploy can both attempt it and one gets "already exists" (42P07 relation,
// 42701 column) instead of a clean no-op. Swallow exactly that race;
// anything else still throws.
export async function ignoringConcurrentCreate(p) {
  try { await p; } catch (e) { if (e?.code !== "42P07" && e?.code !== "42701") throw e; }
}
