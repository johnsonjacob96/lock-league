# Lock League continuous monitoring

Hourly public HTTP/JSON probes and daily mobile/desktop Chromium checks run on GitHub-hosted runners. Successful GitHub deployment-status events also trigger HTTP checks when the deployment provider emits them. Daily schedules use UTC and may be delayed by GitHub; this is periodic monitoring, not an uptime SLA. Review failures and screenshots under Actions → Site monitor. GitHub notification delivery depends on your personal Actions notification settings. No custom email/Slack messages or automatic production changes are configured.

The daily improvement agent requires the `OPENAI_API_KEY` repository secret. Without it, the run explicitly reports that the agent is inactive. API usage is billed separately; each run is limited to 25 minutes and at most one proposed change. It downloads the prior report to avoid repeating unchanged findings and uploads `improvement-proposal` containing a report and any proposed patch. Changes need human review and normal CI before merging. No automatic PR, merge, or deploy is performed. To pause, disable either workflow in GitHub Actions.

Schedules become active only after the workflow files reach the default branch. Configure GitHub Actions usage limits and an OpenAI project budget appropriate for your account before enabling the paid agent. Hourly checks use no OpenAI API calls.

## Coverage

Picks, lock deadlines, odds freshness, settlement, weekly winners, mobile navigation. Never submit picks, initialize data, settle games, send notifications or call cron/admin routes in production.

Public routes: /. Browser checks cover rendered elements, page identity, uncaught JavaScript errors, horizontal overflow, and screenshots at 390px/1440px. They do not prove every user journey works. Production writes are blocked in browser checks. No credentials are passed to the monitor. Authentication, form submission, private data and end-to-end state changes require separate synthetic test accounts/fixtures. A passing public auth-rejection probe does not prove authenticated data loads correctly.

## Local checks

```sh
node .github/monitoring/check.mjs
npm install --prefix .monitor-runtime --no-package-lock playwright@1.60.0
.monitor-runtime/node_modules/.bin/playwright install chromium
node .github/monitoring/check.mjs --browser
```

Output goes to `monitor-output/`. Data/probe failures retry once, then return a nonzero exit code. We Dem Boys snapshots may be up to 72 hours old during its configured NFL refresh season. Completed golf seasons remain valid; update the explicit season data path when the app changes seasons. The Lock League probe validates API structure, not full odds freshness or settlement correctness.

Daily improvement missions are staggered 30 minutes apart across the three apps (this app: 12:17 UTC). Provider retries are extended to tolerate temporary request-rate limits without weakening the sandbox.
