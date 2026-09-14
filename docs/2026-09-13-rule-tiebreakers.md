# Rule-based tiebreakers

Weekly tied W/L records now resolve by Article 7: Super Lock hit, longer original Super Lock odds, season winning percentage, then all-time winning percentage. Both percentages exclude pushes and use results only through the target week. Missing slots remain automatic losses after cutoff; no weekly winner is crowned while any submitted pick is pending.

Season standings use Article 12: most wins, fewest losses, Super Lock wins/fewest losses, total Super Lock odds, then total odds of Super Locks that hit. The owner confirmed that total odds means the sum of potential profit per $1 risked (+150 = 1.5, -120 = 0.8333). In-progress season rankings use settled bets. Weekly wins no longer break season ties. Fully unresolved ties share rank and do not crown a winner. Missing required stored odds stop resolution; no assumed -110 or ambiguous text parsing.

One pure rules module serves server consumers and a generated browser bundle. Weekly payouts, winner notifications, group summaries, completed Live/This Week rankings, week-history cards, and season rank movement use these rules. Pregame/incomplete weekly rankings still use settled records only; hidden picks never break a tie. Historical W/L comes from the existing archive without double-counting imported DB history. Past archive weekly winner entries are preserved.

Rule text includes the owner's clarified definitions. Season payouts remain banker-assigned; no payments, pick grades, or notification sends were performed during this change.

Validation: rule precedence, multiway ties, mixed American odds, missing odds, pushes, pending/cutoff guards, later-week exclusion, payout decisions, mocked winner notifications, and generated browser/server parity. Dedicated mobile/desktop fixtures confirm the same winner and rank across views. Existing render/browser regressions and Cloudflare Functions build pass. A small wrap fix retains the leader icon and You pill without mobile overflow.
