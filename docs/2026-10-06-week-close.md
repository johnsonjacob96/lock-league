# Week 4 close delayed

## What happened

Week 4's picks were all graded by Sunday night (league picks never sit on
Monday night), but the week was not *closed* — winner crowned, "Week 4 is in
the books" pushed — until well into Tuesday.

A week closes in `gradeCurrentWeeks` once the season rolls past it (Tuesday
08:00 UTC). Two things could start that run:

1. **The GitHub `grade-cron` Tuesday 09:00 UTC slot.** It had not fired by
   13:57 UTC. GitHub delivers this repo's scheduled runs late or drops them:
   in the 24 hours before, the hourly site monitor ran 6 times, the
   every-10-minute scoreboard seed a handful of times, and last week's Tuesday
   grade run landed six hours late (15:16 UTC).
2. **Opportunistic grading on app reads (`maybeGrade`).** It only checked the
   *current* week for ungraded picks. After the Tuesday rollover that is the
   new week, usually empty, so it returned "nothing-ungraded" and never looked
   at the finished week.

So closing a week depended on GitHub's scheduler or on luck. A manual
`grade-cron` dispatch at 13:58 UTC confirmed week 4 was by then fully graded
(`allFinal: true`, nothing left to grade) and its results push already sent.

## Fix

- `gradingDue()` decides whether there is work: an ungraded game pick in the
  current or previous week, **or** a finished week with every pick graded that
  has not been closed yet. A week waiting on a manual mark (free-text Super
  Lock) is not re-run every tick.
- `scheduledGrade()` runs grading only when due — one or two small queries
  otherwise, no scoreboard fetch.
- Every `/api/notify` call from the Cloudflare scheduler (every 15 minutes,
  on time) runs `scheduledGrade()` via `waitUntil`. No Worker redeploy needed:
  the Worker already calls this endpoint.
- `maybeGrade()` uses the same check, so an app visit after the rollover also
  closes the week.
- `grade-cron.yml` stays as a backup and a manual "grade now" button.

A finished week now closes within 15 minutes of Tuesday 08:00 UTC.

## Not changed

The GitHub scoreboard seed is equally throttled, but it is a fallback: live
scores and grading read ESPN's web API from Cloudflare first
(see 2026-09-10-live-feed-freshness.md).
