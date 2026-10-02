# Super Lock prop coverage

## Incident
Production menus for multiple Week 4 games had zero markets and zero successful provider pages. Two sequential successful game loads each took three SharpAPI requests; the following Chargers–Seahawks load returned empty. The application shares a 10/minute Sharp budget, allowing props at most eight to reserve board capacity. A paginated menu quickly exhausted that budget. Database cache inspection also found empty Chiefs–Raiders, Rams–Eagles, Patriots–Bills and Titans–Ravens responses.

Last-good recovery only read regional edge storage. A cold isolate could overwrite a durable, previously populated menu with an empty failure even though the database had the earlier menu. Failed responses also lingered in local caches for a minute.

## Change
Use SharpAPI's [event odds endpoint](https://docs.sharpapi.io/en/api-reference/events-odds/), available on all tiers and returning all event rows in one response. Each distinct sportsbook event ID is fetched once; supported-market, book, matchup, week and pricing guards remain. The usual shared event ID now costs one request instead of two or three pages. Quotas and normal 60-second refresh cadence are unchanged.

A refresh loader now receives the previous shared payload. Props can recover its menu for up to 30 minutes, explicitly delayed, with original quote timestamps and a retention clock that failed retries cannot extend. Expired, other-game and other-week data are rejected. Existing submission validation rejects stale prices. Fresh complete menus still remove withdrawn markets normally.

Temporary failures use a 10-second server cache and a 20-second picker retry. The picker explains unavailable/delayed props and keeps manual refresh. Paid touchdown fallback only runs after a successful primary request confirms that market is missing, rather than spending credits during primary throttling.

## Validation
194 backend tests; 344 logic/render checks; 424 Super Lock browser interactions at 375/390/844/1440px. Added coverage for a 960-row event response in one call, FD/DK event IDs, failed-book retention, rate-limit recovery, age/game/week bounds and full cold-isolate recovery through the shared database. Browser checks exercise delayed menus, empty responses and refresh recovery.

Preview has no SharpAPI secret configured; live provider verification must occur after production deployment. The attempted local authenticated vendor diagnostic could not read that encrypted secret and returned 401; it is not evidence of a production key failure. No picks, grades, or notifications were modified.
