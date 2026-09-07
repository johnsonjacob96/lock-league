# Week 1 readiness review — September 6, 2026

Status: fixes tested locally; production deployment and post-deploy verification remain required. Astra structured the review and reviewed pick integrity, ingestion, provider failure modes, and test coverage.

## Confirmed production findings

- Production serves commit `e2852cf` on Cloudflare Pages. The existing smoke suite passed 90 checks but missed request-handler, persistence, cache, and scheduling failures.
- Board coverage varied between polls: initially 9 games; a later probe still missed MIA–LV, GB–MIN, DAL–NYG and a Washington–Philadelphia market. Fifteen Week 1 games are eligible under the league's no-Monday rule.
- Broad SharpAPI `spread,total` aliases consume pages on derivative markets. The exact-market diagnostic returned 496 full-game spread/total rows. The fix requests `point_spread,total_points`, uses the documented page size, and retains both books' event IDs for per-game props.
- The regular-season seed job reports success before September 8 while doing no work. Latest stored Week 1 scoreboard was August 23. The new runner starts during preparation and checks persistence acknowledgments.
- Database contains 14 Week 1 picks, all ungraded, and no Week 2 preseason-test picks. No real picks were changed by this review.
- Jared is collector; weekly buy-in is $90 and prize is $40. LeagueSafe URL is absent; owner input is required.
- Four members have push subscriptions across six devices. Chase, Chris, Jared, and Tyler have none. Actual device delivery was not tested or triggered.
- Deployed notification schedules match configuration: `0 16 * * *`, `0 17 * * SUN`, `0 23 * * *`.
- Preview lacks SharpAPI/provider and VAPID settings and points to a different, unverified database. A preview deployment cannot establish production provider readiness.
- Database/session/cron/Odds API credentials currently use Cloudflare plain-text bindings; migrate these to encrypted secret bindings as a separate configuration task. Values were not printed or committed.

## Fixes

1. Block replacing/removing started or graded picks. Validate incoming and existing kickoffs, Monday eligibility, period, cutoff equality, malformed requests, and ambiguous Super Locks.
2. Require server-sourced structured lines during outages. Serialize member/week mutations and save a full card in one PostgreSQL statement; stale edits save nothing. Preserve microsecond row versions.
3. Display the canonical line actually saved by the server.
4. Refresh expired scoreboard caches from new runner snapshots before stale memory. Seed summaries/boxscores for player props and drilldowns, with bounded ESPN requests and final-summary guards.
5. Keep current and previous scoreboard ingestion separate from active odds. Scope all odds cache reads; prevent public mock/debug cache pollution and refresh quota bypass.
6. Fetch props only for the selected game's FD/DK IDs. Cache and deduplicate requests per game, preserve same-game last-good data through partial pulls, and report incomplete retrieval.
7. Delay payout winners and final-result notifications until cutoff and all submitted picks are graded.
8. Correct Wednesday's opener and add Wednesday-night seed/grading coverage. Retire destructive preseason cleanup at season start.
9. Fail requested smoke layers when they cannot execute; reject HTML SPA responses in API health tests. Prop/scoreboard persistence and scheduler HTTP failures now surface as failures.

## Validation

- `npm test`: **54/54** handler, PostgreSQL, ingestion, prop-cache and cron tests passed.
- `npm run smoke:render`: **82/82** existing logic/viewport checks passed.
- `npm run smoke:browser`: real login, save/reload/remove and provider-failure feedback passed against isolated PostgreSQL; desktop/mobile navigation and 390px screenshot inspected.
- Cloudflare Pages Functions bundle compiled successfully.
- Strengthened production probe failed, correctly exposing the current board's missing games/market. This is evidence against calling the existing deployment ready, not a passing live test of these fixes.
- Local PostgreSQL uses PGlite with the production SQL unchanged. It does not exercise Neon's HTTP transaction transport or real production concurrency. Real postgame prop settlement and notification device delivery remain unproven until exercised in operation.

## Deployment and acceptance

1. Merge the reviewed change; verify Cloudflare production deploys the new commit.
2. Deploy `cron/wrangler.toml` separately to update scheduler error handling (Pages does not deploy that worker).
3. Dispatch `regular-season-seed`; verify 16 Week 1 events persist and the job acknowledges the write. This refresh must happen before Wednesday kickoff.
4. Run `npm run smoke:live` against production. Confirm all 15 upcoming eligible games have spread/total lines, and near-kickoff prop menus are populated. Confirm both books appear where offered.
5. Recheck Wednesday final scores and final boxscore ingestion; ungraded player props must remain pending rather than become guessed losses. Check the Thursday UTC grading run.
6. Before Sunday noon Central, verify reminder readiness and let members without subscriptions opt in on their devices. Set the LeagueSafe URL once supplied.

## API recommendation

Keep SharpAPI for full-game lines/stat props and The Odds API for anytime touchdowns for Week 1. Narrowing and caching requests addresses the observed coverage/rate-limit problem without a late vendor migration. Retain runner ingestion for ESPN while Cloudflare access is unreliable. After Week 1, evaluate a single ingestion job with durable shared snapshots and freshness alerts, avoiding duplicate provider requests across Cloudflare regions.

Sources: [NFL Week 1 schedule](https://www.nfl.com/schedules/2026/by-week/reg-1), [SharpAPI filters/pagination](https://docs.sharpapi.io/en/api-reference/odds/), [The Odds API player markets](https://the-odds-api.com/sports-odds-data/betting-markets.html). Opener: September 9, 7:20 p.m. Central. Weekly cutoff: September 13, noon Central.
