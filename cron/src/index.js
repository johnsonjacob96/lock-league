// Lock League notification scheduler (Cloudflare cron trigger).
//
// Each cron in wrangler.toml maps to one or more notification types below;
// this Worker just fires the matching POST /api/notify?type=... on the app —
// the app's own guards (window check, cutoff, dedupe) decide whether to
// actually send. Reminder has two Sunday-relevant firings and only the
// correct one (relative to the DST-aware noon-CT lock) notifies; line-moves
// fires every 15 minutes and self-guards past the weekly cutoff.
//
// A single quarter-hour trigger checks lines. The original 16:00/23:00 UTC
// reminder slots are dispatched from scheduledTime without adding cron slots.
// Legacy expressions remain recognized during schedule propagation.
//
// This Worker holds NO business logic — it exists purely because Cloudflare cron
// triggers are a reliable scheduler and GitHub Actions cron is not.

const CRON_TYPES = {
  "0 16 * * *": ["reminder", "line-moves"],
  "0 17 * * SUN": ["reminder"],
  "0 23 * * *": ["line-moves", "kickoff-reminder"],
};

async function fireNotify(env, type, { dryrun = false } = {}) {
  if (!env.CRON_SECRET || !env.SITE_URL) throw new Error("Missing scheduler configuration");
  const qs = dryrun ? "&dryrun=1" : "";
  const res = await fetch(`${env.SITE_URL}/api/notify?type=${type}${qs}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "X-Cron-Secret": env.CRON_SECRET },
  });
  const body = await res.text();
  console.log(`[${type}] dryrun=${dryrun} status=${res.status} ${body}`);
  if (!res.ok) throw new Error(`Notification endpoint failed (${res.status})`);
  return { status: res.status, body };
}

export default {
  // Production path: Cloudflare fires this on the cron schedule in wrangler.toml.
  // VERIFY_CRON (an optional var set only during a live scheduling test) makes
  // that one temporary trigger run as a dry-run so it doesn't buzz phones.
  async scheduled(event, env, ctx) {
    const dryrun = Boolean(env.VERIFY_CRON) && event.cron === env.VERIFY_CRON;
    // Keep legacy expressions during trigger propagation; the combined daily
    // expression preserves exactly the same hours and notification handlers.
    const cron = event.cron === "0 16,23 * * *"
      ? `0 ${new Date(event.scheduledTime).getUTCHours()} * * *`
      : event.cron;
    let types = CRON_TYPES[cron];
    if(event.cron === "*/15 * * * *") {
      const time=new Date(event.scheduledTime),hour=time.getUTCHours();
      types=["line-moves"];
      if(time.getUTCMinutes()===0) {
        if(hour===16 || hour===17&&time.getUTCDay()===0)types.push("reminder");
        if(hour===23)types.push("kickoff-reminder");
      }
    }
    if (!types) { console.log(`[scheduled] unrecognized cron: ${event.cron}`); return; }
    ctx.waitUntil(Promise.all(types.map((type) => fireNotify(env, type, { dryrun }))));
  },

  // On-demand verification only (not the production path). Requires the shared
  // secret. ?type=reminder|line-moves (default reminder). ?dryrun=1 computes
  // recipients without sending.
  async fetch(request, env) {
    if (!env.CRON_SECRET || request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "reminder";
    const dryrun = url.searchParams.get("dryrun") === "1";
    const r = await fireNotify(env, type, { dryrun });
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  },
};
