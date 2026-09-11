// ESPN web API is reachable from Cloudflare and avoids the lagging CDN page
// cache. Keep canonical/CDN hosts and persisted runner snapshots as fallbacks.
import { loadSummarySeed } from "./scoreseed.js";

export const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.espn.com/nfl/scoreboard",
};
const WEB = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CDN = "https://cdn.espn.com/core/nfl";

// Fetch + parse JSON defensively. ESPN's hosts are flaky from datacenter IPs:
// site.api 403s, and cdn sometimes returns a 200 with an EMPTY body (which makes
// a naive r.json() throw "Unexpected end of JSON input"). Return null on any of
// those so the caller can try the next host / retry.
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(url, { headers: ESPN_HEADERS, signal: controller.signal });
    if (!r.ok) return null;
    const t = await r.text();
    if (!t) return null;
    return JSON.parse(t);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Scoreboard events for a season / seasontype / week. Returns the events array
// (compatible shapes across hosts). Tries web, canonical, then CDN, with retries,
// because either host can transiently 403 or return an empty body.
export async function espnScoreboardEvents(season, seasontype, week) {
  const q = `year=${season}&seasontype=${seasontype}&week=${week}`;
  const urls = [`${WEB}/scoreboard?${q}`, `${SITE}/scoreboard?${q}`, `${CDN}/scoreboard?xhr=1&${q}`];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const u of urls) {
      const d = await getJson(u);
      const events = d && (Array.isArray(d.events) ? d.events
        : (d.content && d.content.sbData && d.content.sbData.events));
      if (Array.isArray(events) && events.length) return events;
    }
  }
  throw new Error("espn: no events");
}

// Full game summary (leaders, boxscore, situation) for one game. Tries the site
// web/canonical summary hosts then the CDN game host. Returns the summary/gamepackage object or
// null. Used by /api/game for the War Room pick drill-down (player stat leaders).
export async function espnSummary(eventId, env = null) {
  if (!eventId) return null;
  const urls = [`${WEB}/summary?event=${eventId}`, `${SITE}/summary?event=${eventId}`, `${CDN}/game?xhr=1&gameId=${eventId}`];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const u of urls) {
      const d = await getJson(u);
      const gp = d && (d.gamepackageJSON || d);
      if (gp && (gp.leaders || gp.boxscore)) return { ...gp, source_updated_at: new Date().toISOString() };
    }
  }
  return loadSummarySeed(env, eventId);
}

// Box score (player stat lines) for one game. Tries web/canonical summary then CDN
// boxscore, a couple of rounds. Returns the boxscore object or null.
export async function espnBoxscore(eventId, env = null) {
  if (!eventId) return null;
  const urls = [`${WEB}/summary?event=${eventId}`, `${SITE}/summary?event=${eventId}`, `${CDN}/boxscore?xhr=1&gameId=${eventId}`];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const u of urls) {
      const d = await getJson(u);
      const bs = d && (d.boxscore || (d.gamepackageJSON && d.gamepackageJSON.boxscore));
      const status = (d?.gamepackageJSON || d)?.header?.competitions?.[0]?.status?.type;
      if (status && status.completed !== true && status.state !== "post") continue;
      if (bs && Array.isArray(bs.players) && bs.players.length) return bs;
    }
  }
  const seeded = await loadSummarySeed(env, eventId);
  // A live summary can lag a newly-final scoreboard seed. Never grade using
  // partial player stats during that update window.
  return seeded?._seedFinal === true && seeded.boxscore?.players?.length ? seeded.boxscore : null;
}
