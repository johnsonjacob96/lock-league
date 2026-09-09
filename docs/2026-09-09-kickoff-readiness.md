# Kickoff readiness — September 9, 2026

## Confirmed issues and changes

SharpAPI marked ordinary full-game FD spreads as alternate (including NE/SEA,
NO/DET and WAS/PHI). The main-board filter dropped them. The Odds API backup
last refreshed at 15:36 UTC with zero remaining credits, so it could no longer
fill the gaps. No old quotes were reused as live and no subscription purchased.

The adapter now recovers an absent market only from a complete, same-market-ID,
two-sided quote with balanced prices and unique cross-book corroboration (within
1 spread point / 3 total points). If both main markets are missing, both books
must have a unique matching candidate. Existing primary lines take precedence;
ambiguous, inactive, stale, impossible, one-sided, and extreme-price candidates
remain excluded. Each sportsbook retains its own line and prices. The known
polluted 73.5 DK total remains rejected when the other book is around 47.5.

The board also reconciles small bookmaker kickoff discrepancies with the current
week's persisted ESPN schedule. Tonight's countdown now uses 7:20 PM CT, matching
the server pick guard, instead of FanDuel's 7:15 feed time. Missing schedule data
retains the provider time.

## Operational checks

- Scoreboard seeding manually dispatched successfully (run 34396260325), all 16
  games persisted. Direct production score reads also returned fresh ESPN data.
- Wednesday live score fallback and grading schedules are present. The fallback
  still uses best-effort GitHub scheduling every ten minutes during games; it
  cannot promise play-by-play freshness if direct ESPN access fails.
- Deployed Cloudflare notification scheduler dry run succeeded. Runtime push
  health: valid VAPID pair and all 7 subscription keys, 5 members enabled for all
  three notification categories. No notification was sent by this review.
- No registered devices for Chris, Jared or Tyler. Brayden had 1/5 picks, Mason
  4/5, Chris and Jared 0/5 at review time. Everyone else had 5/5. These counts
  can change; Sunday noon CT remains the full-card deadline, early games lock
  individually at kickoff.
- All 25 saved Week 1 picks had actual prices; no picks or payments changed.

## Validation

92 backend tests, 281 logic/render checks, and 336 Super Lock interaction checks.
Worker build passes. Regression tests cover missing-book recovery, both-book
mislabeling, corrupted totals, ambiguous ladders, invalid rows, unchanged main
lines, and kickoff reconciliation. Production verification follows deployment.

## Additional free fallback

Production verification found SharpAPI subsequently omitted the Detroit DK
spread entirely, leaving no quote to corroborate FD. ESPN's scoreboard contains
explicitly identified DraftKings prices under `pointSpread` / `total`, including
DET -7 (-108), NO +7 (-112). The adapter now fills missing DK markets from those
exact current quotes, which can also corroborate the remaining flagged FD quote.
It accepts only provider ID 100 AND name DraftKings, matching game/time, complete
matching sides, valid prices, and data fetched within 15 minutes. It never uses
opening prices or relabels consensus. Healthy Sharp quotes are preserved.

The existing scoreboard snapshot is reused when fresh; otherwise the bounded
ESPN host fallback runs inside the existing odds cache. Missing/stale/invalid
ESPN data leaves the existing paid-backup/safe-unavailable behavior intact.
No new credentials, subscriptions, frontend polling, or sportsbook quota calls.
ESPN-supplemented books retain their actual snapshot time and source label.
95 backend tests and Worker compile pass, including source identity, freshness,
line-pair integrity, preserved primary prices and FD corroboration regressions.
