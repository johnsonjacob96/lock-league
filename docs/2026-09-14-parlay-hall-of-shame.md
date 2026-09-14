# Parlay Hall of Shame

On Parlays, a receipt-style “The Almost Payday” appears when a saved slip has exactly one settled loss and every other leg won. Names the assigned member, shows the missed bet and one X among the hit marks, and calculates the potential profit on a fixed $5 stake. +14819 yields $740.95; −120 yields $4.17. The stake return is excluded. This is a playful hypothetical, not money owed or a payment ledger.

Season-wide, respects the Monday/Thursday filter, and identifies the week on each card. Biggest known amount first; other qualifying slips under keyboard-accessible “More almosts,” which stays expanded through refreshes. No empty placeholder. Unassigned legs say “Mystery picker”; absent/invalid combined odds say “Odds needed.” Pending, multiple losses, all-hit and single-leg slips do not qualify. Pushes/voids are excluded because original combined odds may no longer apply. Result and assignment corrections are reflected from saved data; no new storage, API calls, grading rules or notifications.

Validation: 16 parlay logic tests; 390/1440 browser tests cover hidden pending state, seven-leg display, exact amount, night filtering, keyboard expansion, refresh persistence, correction removal, existing upload/edit workflows and no overflow/page errors. Full GitHub checks run before merge.

Visual fixtures use illustrative results and assignments, not a real member outcome:
- [Mobile preview](previews/2026-09-14/parlay-shame-mobile.png)
- [Desktop preview](previews/2026-09-14/parlay-shame-desktop.png)
