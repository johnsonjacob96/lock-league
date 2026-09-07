# Week 1 handoff — September 7, 2026

Live site: https://lock-league.pages.dev. Repository: johnsonjacob96/lock-league.
Cloudflare Pages deploys main automatically. The notification worker is a separate deployment: `wrangler deploy --config cron/wrangler.toml`.

## Completed

- PR #8: pick integrity, per-game prop caching, Week 1 schedule/score seeding, final boxscore grading, and Wednesday automation review.
- PR #9: deadline/rules clarity, source-age labels, stable live updates, exact-push wording, selected Super Lock stat progress.
- PR #10: missing DraftKings coverage filled using the existing Odds API account; a shared Postgres lease permits one backup refresh attempt per 15 minutes across devices/locations. No new subscription. Quotes show their book update time. Do not replace main prices with fallback quotes when primary markets exist.
- PR #10 notification changes: Wednesday/early-week kickoff reminder using the existing 23:00 UTC trigger, reminder preferences and incomplete-card filtering, once/game deduplication, exclusion of started games from line alerts, safe dry runs, authenticated runtime push health check.
- Follow-up in this change: a total SharpAPI outage must use the same shared backup (or last-good bookmaker snapshot) before ESPN consensus. Final production verification exposed this path after partial-coverage recovery succeeded.

## Verified evidence

- PR #10 local tests: 66 backend/notification tests and 121 logic/browser checks; GitHub checks passed.
- Production initially restored both books for all 15 eligible games (9 book gaps filled by backup at that check). The expanded live probe passed 214 checks. A subsequent forced refresh exposed the total-outage fallback bug addressed in this change; do not treat the earlier pass as proof of that path.
- Production app AND scheduler health dry runs: VAPID key pair/subject valid; 4 subscribed members, 6 valid device subscriptions, 0 invalid subscription keys. Reminder, line-move, and results preferences enabled for all four.
- Subscribed: Brayden (2 devices), Jack (1), Jacob (2), Mason (1). Chase, Chris, Jared, Tyler have no subscription.
- Worker deployed version `7ad61e0c-f5d0-4a98-98e6-429755cc2521`; triggers `0 16 * * *`, `0 17 * * SUN`, `0 23 * * *`. Evening slot now fires line-moves and kickoff-reminder.
- No actual test push sent. Cryptographic validity and configured delivery paths are verified; actual phone receipt is not.

## Continue / verify

1. Check latest main commit against Cloudflare canonical deployment. The PR containing this file records follow-up deployment verification.
2. Run `npm test`, `npm run smoke:render`, and `npm run smoke:live`. Live now requires BOTH books for every game.
3. Authenticated read-only runtime notification check: `/api/notify?type=health&dryrun=1`, header `X-Cron-Secret`. The same request through the scheduler URL verifies its shared-secret path. Obtain existing service access through Cloudflare OAuth; never print or commit credentials.
4. First kickoff: Wednesday September 9, 7:20 PM Central. Earlier-game picks lock at kickoff; overall deadline Sunday September 13 noon Central. Fifteen eligible games; Monday excluded.

## Remaining inputs / constraints

- All collections and distributions use Venmo. Jared must add his Venmo handle in Account to enable collection links.
- Existing backup quota is limited (428 credits remained at the initial coverage audit; a two-market request costs credits). The shared 15-minute lease prevents device-by-device spending. Monitor `odds_backup_snapshot.payload.remaining` if primary gaps persist; no paid upgrade authorized or purchased.
- ESPN runner seed remains every ten minutes during game windows; display now shows source age. GitHub scheduling may lag. This review did not replace that ingestion host.
- Preview environment was not production-equivalent during initial readiness review; do not infer live-secret configuration from a passing preview.

See PRs #8, #9, #10 and the follow-up PR containing this file for implementation and test evidence.
