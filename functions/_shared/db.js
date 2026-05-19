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
