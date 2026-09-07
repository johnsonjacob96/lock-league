# Actual-odds units and season-opening leader

The homepage now shows “Awaiting first results” until decisive results exist and “Tied at the top” when league ranking criteria produce a tie. No member gets an alphabetical leader badge; historical champions are unchanged.

2026 onward uses each pick's saved American odds with 1u risk: a -110 win returns +0.90909u, a +250 win returns +2.5u, and losses return -1u. Pushes return zero; pending picks contribute nothing. Missed submissions remain standings losses but are not wagers. Unpriced settled picks are excluded and flagged; a units-leader claim is withheld while settled prices are incomplete. Totals are summed before rounding to two decimals.

Saved odds survive the live-season merge. Season standings, units tiles, member detail/tooltips, and lifetime totals use the same calculation. Imported 2023–25 estimates remain +1/-1.1 and lifetime labels explain the mixed methodology. Accounting applies to seasons >=2026; this does not replace the app's broader hardcoded 2026 schedule/season-loader configuration. Live standings data refreshes when revisited after its one-minute cache expires.

New board picks require a provider price. Custom Super Locks require valid self-reported American odds; price persists and is visible on the saved card. No historical price was guessed or backfilled from a current line.

Production read-only audit: 14 saved 2026 picks, none graded; 2 lack saved odds (one Under and one custom Super Lock, neither with a nested prop price). Those picks must be re-saved with odds before locking to participate fully in units. Existing picks/results were not changed.

Validation: 70 backend tests and 190 logic/browser checks, including moneyline arithmetic, missing submissions/prices, future-season accounting, leader ties, lifetime aggregation, provider-price rejection, custom-price persistence, and desktop/mobile render. Opening-season mobile preview visually verified.
