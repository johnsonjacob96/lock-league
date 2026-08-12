// Shared ESPN fetch with a host fallback.
//
// ESPN's `site.api.espn.com` host 403s requests coming from datacenter IPs
// (Cloudflare colos) even with a browser User-Agent — it works fine from a
// laptop, which is why it passed local testing but broke in production. The
// `cdn.espn.com/core/...` host serves the SAME data (same event/boxscore shapes)
// and is not IP-blocked. So we try site.api first (canonical) and transparently
// fall back to the CDN host on any failure.
export const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.espn.com/nfl/scoreboard",
};
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CDN = "https://cdn.espn.com/core/nfl";

// Scoreboard events for a season / seasontype / week. Returns the events array
// (identical shape from both hosts). Throws if neither host yields events.
export async function espnScoreboardEvents(season, seasontype, week) {
  const q = `year=${season}&seasontype=${seasontype}&week=${week}`;
  try {
    const r = await fetch(`${SITE}/scoreboard?${q}`, { headers: ESPN_HEADERS });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.events)) return d.events; }
  } catch { /* fall through to CDN */ }
  const r2 = await fetch(`${CDN}/scoreboard?xhr=1&${q}`, { headers: ESPN_HEADERS });
  if (!r2.ok) throw new Error(`espn ${r2.status}`);
  const d2 = await r2.json();
  const events = d2 && d2.content && d2.content.sbData && d2.content.sbData.events;
  if (!Array.isArray(events)) throw new Error("espn: no events");
  return events;
}

// Box score (player stat lines) for one game. Tries site summary, falls back to
// the CDN boxscore. Returns the boxscore object or null.
export async function espnBoxscore(eventId) {
  if (!eventId) return null;
  try {
    const r = await fetch(`${SITE}/summary?event=${eventId}`, { headers: ESPN_HEADERS });
    if (r.ok) { const d = await r.json(); if (d.boxscore) return d.boxscore; }
  } catch { /* fall through to CDN */ }
  try {
    const r = await fetch(`${CDN}/boxscore?xhr=1&gameId=${eventId}`, { headers: ESPN_HEADERS });
    if (r.ok) { const d = await r.json(); return (d && d.gamepackageJSON && d.gamepackageJSON.boxscore) || d.boxscore || null; }
  } catch { /* give up -> null (leaves picks for a later grade run) */ }
  return null;
}
