# Weekly standings cards

The current season standings table, its expandable history, year selector, and historical champion cards remain intact. A Season / This Week switch adds a weekly view with settled W–L records, shared tie ranks, and selectable participant cards. There is no points system.

Desktop displays the selected participant alongside the weekly leaderboard. Mobile expands their card beneath the selected row. Cards retain five slots, confirmed player photos, sportsbook and saved odds, live score/time, and measured progress when stats are available. Hidden slots never disclose pick text. Live projections are not presented as settled wins.

Uses the existing authenticated warroom endpoint and deduplicated game-detail cache; refreshes every 45 seconds while visible. Failed refreshes retain the last available cards with a delayed notice. No new vendor, database, grading, or pick-submission changes.

Validation: 338 logic/render checks across 390/1024/1280px; 376 Super Lock interaction checks across 375/390/844/1440px. Authenticated read-only browser preview with real data at 1440px and 390px showed eight members, five card slots, player photos, and no browser errors. Archived season navigation remains available.

[Desktop browser snapshot](screenshots/2026-09-10-standings-desktop.png)
