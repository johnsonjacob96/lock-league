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
// triggers are a reliable scheduler and GitHub Actions cron is not. It is also
// the clock for the GitHub workflows that must run on a GitHub runner (see
// githubJobsDue below); none of them rely on GitHub's own `schedule:` trigger.

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

// ── GitHub jobs, on this clock ──────────────────────────────────────────────
// Some jobs must run on a GitHub runner: the scoreboard seed needs a network
// ESPN doesn't block, the site monitor drives a real browser, the improvement
// agent works on the repo. GitHub's own `schedule:` trigger is not a clock we
// can use: in October 2026 it delivered a fraction of this repo's runs (the
// hourly monitor ran 6 times in a day; a Tuesday grade run never fired), and
// GitHub documents scheduled runs as best-effort under load. A
// workflow_dispatch, by contrast, starts right away. So this Worker decides
// when each job is due and dispatches it.
//
// Needs GH_DISPATCH_TOKEN: a fine-grained token for this repository with
// "Actions: Read and write". Without it, dispatching is skipped and logged.
const GITHUB_REPO = "johnsonjacob96/lock-league";

// Which GitHub workflows a quarter-hour tick should start. Pure, for tests.
// Times are UTC.
export function githubJobsDue(scheduledTime) {
  const t = new Date(scheduledTime);
  const month = t.getUTCMonth(), day = t.getUTCDay(), hour = t.getUTCHours(), minute = t.getUTCMinutes();
  const jobs = [];
  // Scoreboard seed, NFL season (Sep-Feb): every tick while games are on --
  // Wed/Thu night and Mon night (Thu/Fri/Tue 00-05 UTC), Sunday afternoon and
  // night (Sun 17-24, Mon 00-05 UTC) -- and hourly otherwise.
  const season = month >= 8 || month <= 1;
  const gameWindow = ([1, 2, 4, 5].includes(day) && hour < 5) || (day === 0 && hour >= 17);
  if (season && (gameWindow || minute === 0)) jobs.push({ workflow: "regular-season-seed.yml" });
  // Site monitor: hourly API probes; the daily run at 11:30 UTC (~6:30am CT)
  // adds the mobile and desktop browser checks.
  if (minute === 0) jobs.push({ workflow: "site-monitor.yml", inputs: { browser: "false" } });
  if (hour === 11 && minute === 30) jobs.push({ workflow: "site-monitor.yml", inputs: { browser: "true" } });
  // Improvement agent: once a day, 12:15 UTC (~7:15am CT).
  if (hour === 12 && minute === 15) jobs.push({ workflow: "daily-improvement.yml" });
  return jobs;
}

async function dispatchWorkflow(env, { workflow, inputs }) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lock-league-cron",
    },
    body: JSON.stringify({ ref: "main", ...(inputs ? { inputs } : {}) }),
  });
  if (res.status !== 204) throw new Error(`${workflow}: GitHub dispatch failed (${res.status}) ${await res.text()}`);
  console.log(`[dispatch] ${workflow} ${inputs ? JSON.stringify(inputs) : ""}`);
}

// One failed dispatch must not stop the others, or the notifications.
async function dispatchDue(env, scheduledTime) {
  const jobs = githubJobsDue(scheduledTime);
  if (!jobs.length) return;
  if (!env.GH_DISPATCH_TOKEN) { console.log(`[dispatch] skipped ${jobs.length} job(s): GH_DISPATCH_TOKEN not set`); return; }
  const results = await Promise.allSettled(jobs.map(job => dispatchWorkflow(env, job)));
  for (const r of results) if (r.status === "rejected") console.error(`[dispatch] ${r.reason?.message || r.reason}`);
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
    if (event.cron === "*/15 * * * *" && !dryrun) ctx.waitUntil(dispatchDue(env, event.scheduledTime));
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
