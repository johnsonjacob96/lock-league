import {seedWeeks, seedRegularSeason} from "../../functions/_shared/scoreboard-refresh.js";
import {checkSite} from "./health.js";
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
// triggers provide the app clock. Runner-only jobs and a separate-network
// ESPN fallback retain GitHub schedules; this Worker needs no GitHub token.

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

// Native jobs use public ESPN and the existing app secret, never GitHub auth.
export function nativeJobsDue(scheduledTime) {
  const t = new Date(scheduledTime);
  if (!Number.isFinite(t.getTime()) || t.getUTCMinutes() % 15 !== 0) return [];
  const season = seedWeeks(t.getTime()).length > 0;
  const day = t.getUTCDay(), hour = t.getUTCHours(), minute = t.getUTCMinutes();
  // Include international Sunday and late-season Saturday games. Hourly
  // outside these windows; existing app requests still fetch live data.
  const gameWindow = ([1,2,4,5].includes(day) && hour < 6) || ([0,6].includes(day) && hour >= 12);
  return [ ...(season && (gameWindow || minute === 0) ? ["scoreboard"] : []), ...(minute === 0 ? ["health"] : []) ];
}

export async function runNativeJob(env, job, {dryrun = false, now = Date.now()} = {}) {
  if (job === "scoreboard") return seedRegularSeason({siteUrl:env.SITE_URL,cronSecret:env.CRON_SECRET,now,dryrun});
  if (job === "health") return checkSite(env.SITE_URL);
  throw new Error("Unknown job");
}

async function runScheduled(env, types, jobs, dryrun, now) {
  // Finish every handler even if another fails. Surface failures to Cloudflare
  // after all jobs settle, rather than logging a misleading successful tick.
  const results = await Promise.allSettled([
    ...types.map(type => fireNotify(env,type,{dryrun})),
    ...jobs.map(async job => {
      const result=await runNativeJob(env,job,{dryrun,now});
      console.log(`[${job}] ${JSON.stringify(result)}`);return result;
    }),
  ]);
  const failed=results.filter(r=>r.status==="rejected");
  if(failed.length) throw new AggregateError(failed.map(r=>r.reason),"Scheduler job failed: " + failed.map(r=>r.reason?.message || r.reason).join("; "));
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
    const jobs = event.cron === "*/15 * * * *" && !dryrun ? nativeJobsDue(event.scheduledTime) : [];
    ctx.waitUntil(runScheduled(env,types,jobs,dryrun,event.scheduledTime));
  },

  // On-demand verification only (not the production path). Requires the shared
  // secret. ?type=reminder|line-moves (default reminder). ?dryrun=1 computes
  // recipients without sending.
  async fetch(request, env) {
    if (!env.CRON_SECRET || request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const job = url.searchParams.get("job");
    if (job) {
      if (!["scoreboard","health"].includes(job)) return new Response("Unknown job",{status:400});
      try {
        const result=await runNativeJob(env,job,{dryrun:url.searchParams.get("dryrun")==="1"});
        return Response.json({ok:true,job,result});
      } catch(e) {return Response.json({ok:false,job,error:e.message},{status:502});}
    }
    const type = url.searchParams.get("type") || "reminder";
    const dryrun = url.searchParams.get("dryrun") === "1";
    const r = await fireNotify(env, type, { dryrun });
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  },
};
