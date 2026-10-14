# Super Lock moneylines

Moneyline support previously existed only in the parlay tracker. Super Lock's
game-line picker, board request, validation and grading router supported spreads
and totals, leaving users to enter a manual custom pick.

Super Lock → Game lines now includes Moneyline. Each team's button shows the best
available FanDuel/DraftKings price. The normal -120-or-longer rule, kickoff lock,
replacement confirmation and first-owner rule apply. Unavailable prices have an
explicit message. The submitted quote is the one rendered to the member, so a
background board refresh cannot silently replace it before the server compares it.

The existing SharpAPI main-line request includes the documented `moneyline`
market. Its pagination cap, shared request budget and refresh cadence remain the
same; more rows can require another page within that cap. DraftKings's named
current ESPN quotes can supplement missing moneylines in the same existing
scoreboard response. The paid backup query still requests only its existing
spread/total markets; no additional paid-market credits or new vendor tier.
Reference: [SharpAPI snapshot filters](https://docs.sharpapi.io/en/api-reference/odds/).

Only complete, valid two-way full-game prices are admitted. Period/three-way
markets, alternate/suspended rows, contradictory prices and stale quotes are
withheld. The pair retains the older side's timestamp; freshness does not reset
when another market updates. Existing spread/total recovery rows are preserved
when adding the ESPN supplement.

Saved moneylines carry `prop_meta.kind=moneyline`, the game, selected home/away
side, book and actual price. Grading uses final team scores (tie = push), never a
player boxscore. Live shows measured team margin but remains neutral during the
game; a temporary lead does not become a projected win. Common custom team/ML
aliases canonicalize before new writes so they cannot bypass structured claims.
Custom picks remain explicitly manual.

## Jared's Week 5 correction

Pick 2550 was `Bears ML`, -120, with no game key or structured metadata, so the
automatic grader correctly left a custom pick for manual grading. ESPN event
401872990 confirmed Chicago 7, Green Bay 31 on October 11. A guarded update changed
only that still-ungraded pick's result to L and its grading timestamp on October14.
Original text, price and other saved pick fields were preserved. Jared finished
3–2 for Week 5.

## Verification

- Backend coverage includes full-game filtering, individual quote freshness,
  named DK supplementation, changed-quote rejection, kickoff, -120 threshold,
  cross-book/custom duplicate ownership, and final win/loss/tie routing.
- 468 Super Lock interactions at 375/390/844/1440px passed; the mobile screenshot
  was visually checked. Live presentation tests cover neutral leading/trailing
  moneylines and saved team margin at three widths.
- Snapshot: [mobile picker](previews/2026-10-14/super-lock-moneyline-375.png).

Production provider coverage and deployment IDs are recorded in the project
memory after release. Preview environments do not have the production feed key.
