// NFL helpers: current week computation, pick cutoff, bet types.
// Mirrors lib/nfl.js (kept in sync for Cloudflare Pages Functions runtime).

export const SEASON_2026_KICKOFF = new Date("2026-09-10T00:00:00-04:00");
export const REGULAR_SEASON_WEEKS = 18;

export function currentNflWeek(now = new Date()) {
  const kickoff = SEASON_2026_KICKOFF;
  const week1Start = new Date(kickoff);
  week1Start.setDate(week1Start.getDate() - 2);
  week1Start.setHours(0, 0, 0, 0);

  if (now < week1Start) {
    return { season: null, week: null, status: "offseason" };
  }
  const msPerWeek = 7 * 24 * 3600 * 1000;
  const weekIndex = Math.floor((now - week1Start) / msPerWeek);
  if (weekIndex >= REGULAR_SEASON_WEEKS) {
    return { season: 2026, week: null, status: "postseason" };
  }
  return { season: 2026, week: weekIndex + 1, status: "in-season" };
}

export function pickCutoff(season, week) {
  const week1Start = new Date(SEASON_2026_KICKOFF);
  week1Start.setDate(week1Start.getDate() - 2);
  const weekStart = new Date(week1Start);
  weekStart.setDate(weekStart.getDate() + 7 * (week - 1));
  const sunday = new Date(weekStart);
  sunday.setDate(sunday.getDate() + 5);
  sunday.setHours(1, 0, 0, 0);
  return sunday;
}

export const BET_TYPES = ["Favorite", "Dog", "Over", "Under", "Super Lock"];
