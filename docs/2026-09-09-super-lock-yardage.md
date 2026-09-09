# Yardage sorting and mockup alignment

Corrects the prior interpretation: games are in kickoff order again, with started games still disabled. Game-total ordering and the added O/U labels are removed. Within each yardage market, players sort by descending displayed primary over line (book-specific best-price line), retaining stable original order on ties and putting missing lines last. Non-yardage markets keep provider order. Sorting retains original player indices so a tapped row saves the correct player.

The approved mockup is reflected more closely through larger rectangular portraits beside compact Over/Under controls, abbreviated team headers, quieter typography, and a fixed confirmation footer outside the scrolling player list. All supported markets, alternate lines, custom entry, and game-line selection remain available. Super Lock controls bind as soon as the board renders so the first tap does not wait for the saved-picks fetch.

Validation: 259 existing logic/browser checks and 312 dedicated four-width browser assertions. Includes chronological games, yardage ordering/ties/missing lines, preserved non-yardage ordering, and clicking a sorted player's original index. Existing all-market saves, photos, error recovery, keyboard, and viewport checks pass.

[Updated screenshot](previews/2026-09-09/super-lock-yardage.png) uses illustrative player lines. This supersedes the game-total sorting decision in the earlier photo release.
