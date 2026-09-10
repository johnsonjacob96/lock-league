# Touchdown Scorers restored

SharpAPI carries `anytime_touchdown_scorer`, but its `props` alias does not include that market. The picker had depended on The Odds API backup, whose monthly quota was exhausted.

The existing event-scoped primary request now explicitly includes the scorer market. Native named-player outcomes (`selection_type: other`, null line, `is_player_prop: false`) map to Anytime TD / Yes with original sportsbook prices and source timestamps. Team defense, no-score, first/last scorer and 2+ TD outcomes are excluded. The paid backup is requested only when native scorers are missing. The props cache namespace advances to v6.

Regression coverage verifies both books, player-name fallback, invalid outcomes and no paid backup request when native scorers are present. Existing quote freshness, grading and first-claim Super Lock exclusivity remain in effect.
