# Shared odds refresh — September 9, 2026

Jacob approved optimizing the existing free feeds. Odds-API.io is excluded: Jacob confirmed that issuance of free API keys has been paused indefinitely. No new subscription, credential, or unused provider adapter was added.

## Behavior

- A PostgreSQL refresh lease and cached response coordinate Pages isolates across regions. Cache API remains a secondary layer; it is not globally shared.
- The board checks for changes every 15 seconds while visible. The shared board refresh window is 30 seconds. Prop menus use a 60-second shared window and refresh while open. Actual freshness still depends on SharpAPI's free feed delay and market availability.
- SharpAPI uses a shared sliding budget of 10 requests/minute; props can consume at most 8, reserving capacity for the game board. HTTP 429 backoff applies across regions. The Odds API fallback has a shared 12-credit/day ceiling, with monthly quota exhaustion backoff; no tier increase.
- The current week's Sharp event catalog is reused for ten minutes. Subsequent requests target upcoming event IDs rather than repeatedly scanning the season. Pagination is bounded. Global cutoff stops odds/prop refreshes; scores remain independent.
- ESPN's schedule preserves matchups omitted from an odds response. Missing quotes remain unavailable rather than being invented or relabeled. Explicitly identified ESPN DraftKings quotes remain the supplementary source shipped in PR34.
- Every normalized main market/prop/alternate retains its source timestamp. Pick validation rejects quotes older than two minutes, invalid future timestamps, and explicitly stale retained props. Refreshing cached data does not reset quote age.
- New clients submit the book, line and price they displayed. A changed quote returns 409 and requires review; the original saved picks remain intact. A missing requested sportsbook cannot silently switch to another book. Older clients still receive canonical server pricing and freshness checks.
- Missing/restored individual markets now update their card buttons. Delayed book quotes have a visible freshness message. Existing layouts, logos, portraits, player sorting and saved picks are preserved.

## Validation

Backend tests include actual PostgreSQL semantics through PGlite: concurrent cold readers, null cache entries, failed refreshes, abandoned leases, concurrent quota claims, reserved capacity, rate-limit backoff, credit accounting, missing schedule entries and per-market freshness. Pick handler tests cover quote reconfirmation and preserved saved picks.

Run `npm test`, `npm run smoke`, `npm run smoke:render`, `npm run smoke:super-lock`, `npm run smoke:browser`, and `wrangler pages functions build functions --outdir /tmp/lock-league-build`.

## Operational limits

This does not guarantee continuous FanDuel/DraftKings availability. Suspended, delayed or missing vendor markets remain unavailable for new picks. Previously saved picks and grading do not depend on current odds. The quota guard trades repeated unsuccessful calls for bounded retries; under heavy simultaneous prop browsing, some menus can be delayed. The existing manual Super Lock route remains available.

Tables `feed_refresh` and `feed_budget` are additive and created on first use. Deployment needs no new secrets. Reverting this release restores the old refresh behavior; these cache tables may remain without affecting picks or payments.

## Production follow-up: combined prop classification

The mobile production screenshot exposed DraftKings' `player_passing_+_rushing_yards` (Drake Maye 259.5) being classified as rushing yards. Combined passing/rushing is not supported by the current single-stat grader and is now excluded before any stat-category fallback. Supported rushing+receiving remains intact. The same guard prevents longest/half/quarter labels from returning through a broad category. Prop cache keys advance to v5 so previously normalized bad labels cannot survive in last-good storage. A regression test covers each case; backend suite now has 108 passing tests.
