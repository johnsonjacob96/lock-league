// Run from GitHub's network: Cloudflare cannot reliably reach ESPN.
import { pathToFileURL } from "node:url";
import { WEEK1_START_MS, REGULAR_SEASON_WEEKS } from "../functions/_shared/nfl.js";

const WEEK = 7 * 24 * 3600 * 1000;
export function seedWeeks(now = Date.now()) {
  if (now < WEEK1_START_MS - 2 * WEEK || now >= WEEK1_START_MS + (REGULAR_SEASON_WEEKS + 2) * WEEK) return [];
  const current = Math.min(REGULAR_SEASON_WEEKS, Math.max(1, Math.floor((now - WEEK1_START_MS) / WEEK) + 1));
  return current > 1 ? [current, current - 1] : [1];
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function espnData(urls, extract) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of urls) {
      try {
        const data = extract(await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } }));
        if (data) return data;
      } catch { /* bounded retry on the alternate ESPN host */ }
    }
  }
  return null;
}

export async function seedRegularSeason({ siteUrl, cronSecret, now = Date.now(), log = console.log } = {}) {
  if (!siteUrl || !cronSecret) throw new Error("SITE_URL and CRON_SECRET must be set");
  const weeks = seedWeeks(now);
  const failures = [], results = [];
  for (const week of weeks) {
    const query = `year=2026&seasontype=2&week=${week}`;
    const events = await espnData([
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?${query}`,
      `https://cdn.espn.com/core/nfl/scoreboard?xhr=1&${query}`,
    ], data => {
      const list = data.events || data.content?.sbData?.events;
      return Array.isArray(list) && list.length ? list : null;
    });
    if (!events) { failures.push(`week ${week}: scoreboard unavailable`); continue; }

    const summaries = {};
    const playing = events.filter(ev => {
      const status = ev.status?.type || ev.competitions?.[0]?.status?.type;
      return status?.state === "in" || status?.state === "post" || status?.completed;
    });
    // Bound provider fanout while keeping a 16-game Sunday refresh quick.
    for (let offset = 0; offset < playing.length; offset += 4) {
      await Promise.all(playing.slice(offset, offset + 4).map(async ev => {
        const summary = await espnData([
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`,
          `https://cdn.espn.com/core/nfl/game?xhr=1&gameId=${ev.id}`,
        ], data => {
          const gp = data.gamepackageJSON || data;
          return gp.boxscore?.players?.length ? gp : null;
        });
        const summaryStatus = summary?.header?.competitions?.[0]?.status?.type;
        const summaryFinal = summaryStatus?.completed === true || summaryStatus?.state === "post";
        if (summary) summaries[String(ev.id)] = {
          _seedFinal: summaryFinal,
          boxscore: summary.boxscore, leaders: summary.leaders,
          situation: summary.situation || summary.header?.competitions?.[0]?.situation };
        else failures.push(`week ${week}, event ${ev.id}: boxscore unavailable`);
      }));
    }
    try {
      const acknowledgment = await fetchJson(new URL("/api/odds?action=seed", siteUrl), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": cronSecret },
        body: JSON.stringify({ season: 2026, week, seasontype: 2, source: "espn", scoreboardOnly: true, events, summaries }),
      });
      if (!acknowledgment.ok || acknowledgment.scoreboardSeeded !== true ||
          acknowledgment.summariesSeeded !== Object.keys(summaries).length) {
        throw new Error("snapshot persistence not acknowledged");
      }
      results.push({ week, events: events.length, summaries: Object.keys(summaries).length });
      log(`week ${week}: ${events.length} events, ${Object.keys(summaries).length} boxscores persisted`);
    } catch (error) { failures.push(`week ${week}: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join("; "));
  if (!weeks.length) log("outside regular-season seed window");
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedRegularSeason({ siteUrl: process.env.SITE_URL, cronSecret: process.env.CRON_SECRET })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
