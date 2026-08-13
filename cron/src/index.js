// Lock League reminder scheduler (Cloudflare cron trigger).
//
// The cron trigger fires POST /api/notify?type=reminder on the app; the app's
// window guard decides whether to actually send (only ~1h before the noon-CT
// lock), so both Sunday cron times can fire and only the correct one notifies.
//
// This Worker holds NO business logic — it exists purely because Cloudflare cron
// triggers are a reliable scheduler and GitHub Actions cron is not.

async function fireReminder(env, { dryrun = false } = {}) {
  const qs = dryrun ? "&dryrun=1" : "";
  const res = await fetch(`${env.SITE_URL}/api/notify?type=reminder${qs}`, {
    method: "POST",
    headers: { "X-Cron-Secret": env.CRON_SECRET },
  });
  const body = await res.text();
  console.log(`[reminder] dryrun=${dryrun} status=${res.status} ${body}`);
  return { status: res.status, body };
}

export default {
  // Production path: Cloudflare fires this on the cron schedule in wrangler.toml.
  // VERIFY_CRON (an optional var set only during a live scheduling test) makes
  // that one temporary trigger run as a dry-run so it doesn't buzz phones.
  async scheduled(event, env, ctx) {
    const dryrun = Boolean(env.VERIFY_CRON) && event.cron === env.VERIFY_CRON;
    ctx.waitUntil(fireReminder(env, { dryrun }));
  },

  // On-demand verification only (not the production path). Requires the shared
  // secret. ?dryrun=1 computes recipients without sending.
  async fetch(request, env) {
    if (request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const dryrun = new URL(request.url).searchParams.get("dryrun") === "1";
    const r = await fireReminder(env, { dryrun });
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  },
};
