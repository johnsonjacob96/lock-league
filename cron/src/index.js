// Lock League notification scheduler (Cloudflare cron trigger).
//
// Each cron in wrangler.toml maps to one or more notification types below;
// this Worker just fires the matching POST /api/notify?type=... on the app —
// the app's own guards (window check, cutoff, dedupe) decide whether to
// actually send. Reminder has two Sunday-relevant firings and only the
// correct one (relative to the DST-aware noon-CT lock) notifies; line-moves
// fires twice daily and self-guards past the weekly cutoff.
//
// The 16:00 UTC slot is SHARED between reminder and line-moves (see
// wrangler.toml) to stay within the account's 5-cron-trigger Free plan cap —
// both handlers already no-op safely when it isn't "their" moment, so firing
// both off one trigger is harmless, just an extra no-op HTTP call on the six
// non-Sunday days.
//
// This Worker holds NO business logic — it exists purely because Cloudflare cron
// triggers are a reliable scheduler and GitHub Actions cron is not.

const CRON_TYPES = {
  "0 16 * * *": ["reminder", "line-moves"],
  "0 17 * * SUN": ["reminder"],
  "0 23 * * *": ["line-moves"],
};

async function fireNotify(env, type, { dryrun = false } = {}) {
  const qs = dryrun ? "&dryrun=1" : "";
  const res = await fetch(`${env.SITE_URL}/api/notify?type=${type}${qs}`, {
    method: "POST",
    headers: { "X-Cron-Secret": env.CRON_SECRET },
  });
  const body = await res.text();
  console.log(`[${type}] dryrun=${dryrun} status=${res.status} ${body}`);
  return { status: res.status, body };
}

export default {
  // Production path: Cloudflare fires this on the cron schedule in wrangler.toml.
  // VERIFY_CRON (an optional var set only during a live scheduling test) makes
  // that one temporary trigger run as a dry-run so it doesn't buzz phones.
  async scheduled(event, env, ctx) {
    const dryrun = Boolean(env.VERIFY_CRON) && event.cron === env.VERIFY_CRON;
    const types = CRON_TYPES[event.cron];
    if (!types) { console.log(`[scheduled] unrecognized cron: ${event.cron}`); return; }
    ctx.waitUntil(Promise.all(types.map((type) => fireNotify(env, type, { dryrun }))));
  },

  // On-demand verification only (not the production path). Requires the shared
  // secret. ?type=reminder|line-moves (default reminder). ?dryrun=1 computes
  // recipients without sending.
  async fetch(request, env) {
    if (request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "reminder";
    const dryrun = url.searchParams.get("dryrun") === "1";
    const r = await fireNotify(env, type, { dryrun });
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  },
};
