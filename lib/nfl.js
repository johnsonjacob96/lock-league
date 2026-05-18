// NFL helpers: current week computation, season window

// 2026 NFL regular season: Thursday Sept 10, 2026 (kickoff) — Sun Jan 3 2027
// Week N starts on Tuesday at 12:00 AM ET preceding the Thursday game.
export const SEASON_2026_KICKOFF = new Date("2026-09-10T00:00:00-04:00"); // ET
export const REGULAR_SEASON_WEEKS = 18;

/**
 * Compute the current NFL week given a date.
 * Returns { season, week } or { season: null, week: null } if offseason.
 */
export function currentNflWeek(now = new Date()) {
  const kickoff = SEASON_2026_KICKOFF;
  // Week 1 starts Tuesday before kickoff (Sept 8, 2026)
  const week1Start = new Date(kickoff);
  week1Start.setDate(week1Start.getDate() - 2); // Tue
  week1Start.setHours(0, 0, 0, 0);

  if (now < week1Start) {
    // Preseason / offseason — return null
    return { season: null, week: null, status: "offseason" };
  }
  const msPerWeek = 7 * 24 * 3600 * 1000;
  const weekIndex = Math.floor((now - week1Start) / msPerWeek);
  if (weekIndex >= REGULAR_SEASON_WEEKS) {
    return { season: 2026, week: null, status: "postseason" };
  }
  return { season: 2026, week: weekIndex + 1, status: "in-season" };
}

/**
 * Cutoff: Sunday 12:00 AM CT for the given week.
 * Anything submitted after this is locked.
 */
export function pickCutoff(season, week) {
  // Cutoff = the Sunday 00:00 CT (= 06:00 UTC during DST, 05:00 UTC outside DST)
  // Approximation good enough: Sunday 5:00 AM UTC of that week
  const week1Start = new Date(SEASON_2026_KICKOFF);
  week1Start.setDate(week1Start.getDate() - 2);
  const weekStart = new Date(week1Start);
  weekStart.setDate(weekStart.getDate() + 7 * (week - 1));
  // weekStart is Tuesday 00:00 ET. Sunday is +5 days.
  const sunday = new Date(weekStart);
  sunday.setDate(sunday.getDate() + 5); // Sunday
  sunday.setHours(0, 0, 0, 0);
  // Convert to CT: ET is UTC-4 in DST, CT is UTC-5. So Sun 00:00 CT = Sun 01:00 ET.
  sunday.setHours(1, 0, 0, 0);
  return sunday;
}

export const BET_TYPES = ["Favorite", "Dog", "Over", "Under", "Super Lock"];
