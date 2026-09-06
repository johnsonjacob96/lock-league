// NFL helpers: current week computation, pick cutoff, odds window, bet types.
// Mirrors lib/nfl.js (kept in sync for Cloudflare Pages Functions runtime).
// All math is done in explicit UTC — nothing depends on the host timezone.

export const REGULAR_SEASON_WEEKS = 18;
const MS_WEEK = 7 * 24 * 3600 * 1000;

// 2026 kickoff: Wednesday Sept 9, 2026 8:20pm ET (NE at SEA).
// Week N runs Tuesday → Tuesday. Week 1 starts Tue Sept 8, 08:00 UTC
// (≈ 3–4am ET, safely after Monday Night Football ends).
export const WEEK1_START_MS = Date.UTC(2026, 8, 8, 8);
export const SEASON_2026_KICKOFF = new Date(Date.UTC(2026, 8, 10, 0, 20)); // Wed 8:20pm ET

// ── Preseason test mode ─────────────────────────────────────────────────────
// Set env.LL_TEST_MODE=1 to point the WHOLE app at 2026 preseason Week 2
// (games Thu Aug 13 → Sun Aug 16) for an end-to-end dry run before the season.
// Every season-aware path checks this: current week, cutoff, odds/score window,
// scoreboard seasontype, and which week the grader covers. Clear the env var to
// return to normal regular-season behavior (nothing else to undo).
const PRESEASON_TEST = {
  season: 2026,
  week: 2,
  seasontype: 1, // ESPN: 1 = preseason, 2 = regular
  cutoffMs: Date.UTC(2026, 7, 13, 23, 0), // Thu Aug 13 2026, 6:00pm CT — lock + War Room reveal
  windowFromMs: Date.UTC(2026, 7, 11, 0), // odds/game scoping window (UTC): Aug 11-18
  windowToMs: Date.UTC(2026, 7, 18, 0),
  // Auto-activation window: the LL_TEST_MODE secret can be set well in advance;
  // it only actually takes effect between these times, then reverts on its own.
  // End = Sat Aug 15 14:00 UTC (9:00am CT): Thursday games are graded and Jacob
  // reviews Friday, then the app auto-flips back to regular-season Week 1 on
  // Saturday. (The season-2026/week-2 test picks are wiped separately by the
  // flip-back workflow so they don't pollute the real regular-season week 2.)
  activeFromMs: Date.UTC(2026, 7, 12, 12), // Wed Aug 12 2026, 7:00am CT
  activeToMs: Date.UTC(2026, 7, 15, 14),   // Sat Aug 15 2026, 9:00am CT
};
// Returns the preseason-test config only when the env flag is set AND we are
// inside the activation window, so setting the secret early is safe.
export function testConfig(env, now = Date.now()) {
  const v = env && env.LL_TEST_MODE;
  if (!(v === "1" || v === "true" || v === 1 || v === true)) return null;
  if (now < PRESEASON_TEST.activeFromMs || now >= PRESEASON_TEST.activeToMs) return null;
  return PRESEASON_TEST;
}
// ESPN seasontype for score/board fetches (1 preseason under test, else 2).
export function seasonTypeFor(env) {
  const tc = testConfig(env);
  return tc ? tc.seasontype : 2;
}

export function currentNflWeek(now = new Date(), env = null) {
  const tc = testConfig(env, now.getTime());
  if (tc) return { season: tc.season, week: tc.week, status: "in-season", preseason: true };
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
export function pickCutoff(season, week, env = null) {
  const tc = testConfig(env);
  if (tc) return new Date(tc.cutoffMs);
  const sundayNoonMs = Date.UTC(2026, 8, 13, 12) + (week - 1) * MS_WEEK;
  const utcOffsetHours = sundayNoonMs >= Date.UTC(2026, 10, 1, 12) ? 6 : 5;
  return new Date(sundayNoonMs + utcOffsetHours * 3600 * 1000);
}

/**
 * Kickoff window (Tue → Tue, ISO strings) for a week's games.
 * Used to scope The Odds API call to a single week.
 */
export function weekWindow(week, env = null) {
  const tc = testConfig(env);
  if (tc) return { from: isoNoMs(tc.windowFromMs), to: isoNoMs(tc.windowToMs) };
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
export function weeksToGrade(now = new Date(), env = null) {
  const tc = testConfig(env);
  if (tc) return [tc.week];
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
