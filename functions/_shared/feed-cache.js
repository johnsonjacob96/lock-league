// Global refresh leases and sliding-window quotas across all Pages isolates.
import { sql, ignoringConcurrentCreate } from "./db.js";
let ready;
async function ensure(env) {
  if (!ready)
    ready = (async () => {
      const db = sql(env);
      await ignoringConcurrentCreate(db`CREATE TABLE IF NOT EXISTS feed_refresh (
      cache_key TEXT PRIMARY KEY, payload JSONB, expires_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
      lease_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch', owner TEXT)`);
      await ignoringConcurrentCreate(db`CREATE TABLE IF NOT EXISTS feed_budget (
      provider TEXT PRIMARY KEY, requests DOUBLE PRECISION[] NOT NULL DEFAULT '{}', blocked_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch')`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  await ready;
}
export async function sharedFeed(env, key, ttlMs, load) {
  if (!env?.DATABASE_URL) return load();
  await ensure(env);
  const db = sql(env);
  await db`INSERT INTO feed_refresh(cache_key) VALUES(${key}) ON CONFLICT DO NOTHING`;
  const read = async () =>
    (
      await db`SELECT payload,expires_at FROM feed_refresh WHERE cache_key=${key}`
    )[0];
  let old = await read();
  if (old && Date.parse(old.expires_at) > Date.now()) return old.payload;
  const owner = crypto.randomUUID();
  const claim =
    await db`UPDATE feed_refresh SET owner=${owner},lease_until=NOW()+INTERVAL '45 seconds'
    WHERE cache_key=${key} AND lease_until<=NOW() AND expires_at<=NOW() RETURNING cache_key`;
  if (!claim.length) {
    // Do not stamp old quotes as fresh while another isolate refreshes.
    if (old?.payload) return { ...old.payload, refreshing: true };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      old = await read();
      if (old && Date.parse(old.expires_at) > Date.now()) return old.payload;
    }
    throw Error("feed-refresh-in-progress");
  }
  try {
    const payload = await load();
    const ttl = payload?.stale ? Math.min(ttlMs, 10000) : ttlMs;
    await db`UPDATE feed_refresh SET payload=${JSON.stringify(payload)}::jsonb,
      expires_at=NOW()+(${ttl} * INTERVAL '1 millisecond'),lease_until='epoch',owner=NULL
      WHERE cache_key=${key} AND owner=${owner}`;
    return payload;
  } catch (e) {
    await db`UPDATE feed_refresh SET lease_until=NOW()+INTERVAL '10 seconds',owner=NULL WHERE cache_key=${key} AND owner=${owner}`;
    if (old?.payload) return { ...old.payload, stale: true, live: false };
    throw e;
  }
}
const LIMITS = {
  sharp: { window: 60, limit: 10, hour: 10 },
  oddsapi: { window: 86400, limit: 12, hour: 12 },
};
export async function providerFetch(
  env,
  provider,
  url,
  init = {},
  cost = 1,
  priority = "board",
) {
  if (!env?.DATABASE_URL) return fetch(url, init);
  await ensure(env);
  const db = sql(env),
    limit = LIMITS[provider];
  if (!limit) throw Error("unknown-feed-provider");
  await db`INSERT INTO feed_budget(provider) VALUES(${provider}) ON CONFLICT DO NOTHING`;
  const claim = await db`UPDATE feed_budget SET requests=
    ARRAY(SELECT t FROM unnest(requests) t WHERE t>EXTRACT(EPOCH FROM NOW())-${limit.window}) ||
    array_fill(EXTRACT(EPOCH FROM NOW())::double precision,ARRAY[${cost}::int])
    WHERE provider=${provider} AND blocked_until<=NOW()
      AND (SELECT count(*) FROM unnest(requests) t WHERE t>EXTRACT(EPOCH FROM NOW())-${limit.window})+${cost}<=${provider === "sharp" && priority === "props" ? 8 : limit.limit}
      AND (SELECT count(*) FROM unnest(requests) t WHERE t>EXTRACT(EPOCH FROM NOW())-3600)+${cost}<=${provider === "sharp" ? 100000 : limit.hour}
    RETURNING provider`;
  if (!claim.length) throw Error("feed-budget-wait");
  const response = await fetch(url, init);
  if (
    response.status === 429 ||
    (provider === "oddsapi" &&
      response.headers.get("x-requests-remaining") === "0")
  ) {
    const retry = response.headers.get("retry-after");
    let seconds = Number(retry);
    if (!retry || !Number.isFinite(seconds))
      seconds = retry
        ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
        : 60;
    if (!Number.isFinite(seconds)) seconds = 60;
    if (
      provider === "oddsapi" &&
      response.headers.get("x-requests-remaining") === "0"
    ) {
      const now = new Date();
      seconds =
        (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) -
          Date.now()) /
        1000;
    }
    await db`UPDATE feed_budget SET blocked_until=GREATEST(blocked_until,NOW()+(${Math.max(1, seconds)} * INTERVAL '1 second')) WHERE provider=${provider}`;
  }
  return response;
}
