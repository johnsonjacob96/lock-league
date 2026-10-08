# Scheduling review — October 8, 2026

PR92 originally replaced GitHub schedules with Worker-initiated GitHub workflow dispatches, requiring a new `GH_DISPATCH_TOKEN`. That is runtime GitHub authorization, not Cloudflare deployment authorization. Existing Wrangler OAuth already deploys the Worker. A desktop OAuth login is not automatically an identity in a remote Worker; copying the CLI's broad GitHub token there is not the solution.

Owner chose to retain GitHub for runner-only work and move app work directly to Cloudflare. PR92 is revised in place, preserving the previous author's expired-workflow cleanup and manual-only grade button:

- Existing quarter-hour notification/grade/week-close clock remains unchanged.
- Worker fetches and persists ESPN current/previous-week scoreboard and boxscore snapshots directly, using the reachable ESPN web host first. Shared ingestion is reused by the runner; final-summary flags and persistence acknowledgments remain enforced.
- Direct refresh runs every 15 minutes in game windows (including international Sunday/Saturday windows), hourly otherwise during the existing regular-season seed window.
- Worker performs hourly homepage/config/scores health checks. Each job settles independently; failures mark the invocation failed instead of silently skipping work.
- GitHub scoreboard seeding remains an independent-network fallback. Full browser/asset monitoring and the daily coding agent retain their GitHub schedules. No new GitHub or Cloudflare token; no new secret.
- Removed four obsolete preseason workflows, including the yearly August `wipe-test` trigger. No current picks or historical data were deleted.

Deployment: Worker version `7b4289f7-992c-43d3-b809-d2df65b63126` deployed using Wrangler OAuth. Verified from the actual Worker: health checks pass; read-only seed dry run returned Week5 15 events and Week4 16 events/16 boxscores; authenticated refresh persisted the same snapshots with acknowledgments. No manual notification sends. The existing encrypted CRON_SECRET was retained.

Validation: 217 full backend tests and 83 logic checks passed before the Worker-specific redirect correction; all 13 scheduler tests then passed including a regression for Cloudflare's manual-redirect requirement. CI reruns the full suite on the final revision. Worker dry-run bundle succeeds. Pages and Worker deploy separately; a main push alone does not deploy the Worker.

Separate finding: the October8 daily coding-agent run 37827781879 failed with `Quota exceeded` from the model service. This is independent of scheduling. No billing changes or new paid runs requested.
