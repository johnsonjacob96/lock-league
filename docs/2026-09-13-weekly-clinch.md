# Early weekly winners

A locked week now awards its winner once the leader's worst possible finish beats every rival's best possible finish under Article 7. Remaining picks retain their real settled/live/pending status and continue to affect season records. No score projections, synthetic grades, or additional odds API calls.

The shared browser/server decision returns `clinched: true` separately from `complete`. Standings weekly-win totals, Live recap/rank, This Week rank and payout eligibility consume the same winner. Live and This Week label the early result “Clinched.” End-of-week push summaries keep their existing timing; no extra messages are sent on a clinch.

The bound comparison includes wins, losses, Super Lock hit, original saved odds, and best/worst season and all-time winning percentages. Pushes cannot produce a better finish than a win or a worse finish than a loss. Missing required tiebreak data, unresolved ties, empty weeks and unlocked cards cannot award a winner. Picks are treated independently, so correlated bets can conservatively delay a clinch, never create a false one. Existing final grades are authoritative; a later commissioner grade correction triggers recomputation.

Week 1 read-only validation: Mason 4–1 has a winning SL; Chris 4–1 missed his SL. Brayden can reach 4–1 with his open SL, but Mason's −113 is longer than Brayden's −120. The shared calculation therefore recognizes Mason without grading Brayden's pick.

Validation includes the Week 1 case, catchable leaders, pushes, unknown odds, percentage bounds, an exhaustive independent W/L/P completion check, payout integration, generated browser/server parity, and 390/1440 px UI checks. All tests use isolated fixtures; production checks are read-only.
