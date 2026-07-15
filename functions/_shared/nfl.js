// NFL helpers: current week computation, pick cutoff, odds window, bet types.
// Mirrors lib/nfl.js (kept in sync for Cloudflare Pages Functions runtime).
// All math is done in explicit UTC — nothing depends on the host timezone.

export const REGULAR_SEASON_WEEKS = 18;
const MS_WEEK = 7 * 24 * 3600 * 1000;

// 2026 kickoff: Thursday Sept 10, 2026 8:20pm ET (TNF opener).
// Week N runs Tuesday → Tuesday. Week 1 starts Tue Sept 8, 08:00 UTC
// (≈ 3–4am ET, safely after Monday Night Football ends).
export const WEEK1_START_MS = Date.UTC(2026, 8, 8, 8);
export const SEASON_2026_KICKOFF = new Date(Date.UTC(2026, 8, 11, 0, 20)); // Thu 8:20pm ET

export function currentNflWeek(now = new Date()) {
  const t = now.getTime();
  if (t < WEEK1_START_MS) {
    return { season: null, week: null, status: "offseason" };
  }
  const weekIndex = Math.floor((t - WEEK1_START_MS) / MS_WEEK);
  if (weekIndex >= REGULAR_SEASON_WEEKS) {
    return { season: 2026, week: null, status: "postseason" };
  }
  return { season: 2026, week: weekIndex + 1, status: "in-season" };
}

/**
 * Cutoff: Sunday 12:00 PM (noon) Central Time for the given week.
 * Week 1's Sunday is Sept 13, 2026. Central is UTC-5 (CDT) until DST ends
 * Nov 1 2026 at 2am — so noon on Nov 1 itself is already CST (UTC-6).
 * Games that kick off earlier than the cutoff are locked per-game at
 * kickoff (see /api/picks POST).
 */
export function pickCutoff(season, week) {
  const sundayNoonMs = Date.UTC(2026, 8, 13, 12) + (week - 1) * MS_WEEK;
  const utcOffsetHours = sundayNoonMs >= Date.UTC(2026, 10, 1, 12) ? 6 : 5;
  return new Date(sundayNoonMs + utcOffsetHours * 3600 * 1000);
}

/**
 * Kickoff window (Tue → Tue, ISO strings) for a week's games.
 * Used to scope The Odds API call to a single week.
 */
export function weekWindow(week) {
  const fromMs = WEEK1_START_MS + (week - 1) * MS_WEEK;
  return { from: isoNoMs(fromMs), to: isoNoMs(fromMs + MS_WEEK) };
}
function isoNoMs(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * Which weeks should a scheduled grading run cover?
 * Current week (in-flight games) plus the previous week (late finals, MNF
 * graded on the Tuesday run after the week rolls over). Empty in the
 * offseason and once the season has been fully settled.
 */
export function weeksToGrade(now = new Date()) {
  const cur = currentNflWeek(now);
  if (cur.status === "offseason") return [];
  if (cur.status === "postseason") {
    const seasonEndMs = WEEK1_START_MS + REGULAR_SEASON_WEEKS * MS_WEEK;
    if (now.getTime() > seasonEndMs + 2 * MS_WEEK) return [];
    return [REGULAR_SEASON_WEEKS];
  }
  return cur.week > 1 ? [cur.week - 1, cur.week] : [cur.week];
}

export const BET_TYPES = ["Favorite", "Dog", "Over", "Under", "Super Lock"];
