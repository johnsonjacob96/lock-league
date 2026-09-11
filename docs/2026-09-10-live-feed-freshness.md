# Live tracking freshness

The previous ESPN route tried site.api (403 from Cloudflare) then the CDN page feed. On a Cloudflare remote preview, the CDN scoreboard reported 49ers/Rams at 0:47 in Q4 while ESPN's site.web.api scoreboard already reported Final. The web API returned both scoreboard and player summaries successfully. The runner snapshot fallback is scheduled every ten minutes; recent successful runs were more than thirteen minutes apart, so it cannot provide a live cadence by itself.

Changes:
- Try ESPN's web API first for scoreboard, player summary and final grading boxscores. Preserve canonical, CDN, and stored snapshot fallbacks, including final-only grading protection.
- Reduce scoreboard/game/weekly server caches to ten seconds; remove the additional browser cache on /api/scores.
- Refresh Live and Standings This Week every fifteen seconds, with a ten-second client game cache and immediate refresh when returning to the tab. Hidden tabs remain paused.
- No new paid data service or continuously running GitHub job.

Validation: Cloudflare remote host comparisons; 119 backend tests (web-host priority, malformed responses, fallback, timeout and grading checks), 338 logic/render checks, and Functions build. The game finished during investigation: verify production's final scores/player data after deployment; measure end-to-end in-game latency during the next live game. A shorter polling interval does not guarantee the upstream feed itself is current.
