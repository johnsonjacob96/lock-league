# Super Lock selection panel

Replaces the crowded inline picker in My Card with a native modal: choose a matchup using team logos, browse player props or game lines, and confirm the selected line, price, and sportsbook. Mobile uses the full screen; desktop uses a centered panel. Existing saved picks and manual grading stay in My Card.

All 13 supported canonical prop markets remain available. The market filters are generated from the returned menu, with All props, player search, and expandable alternate over lines. No additional vendor requests are introduced. Unavailable markets are not invented; custom entry remains available for unsupported bets. Player initials are used because the pregame prop menu does not supply verified headshots.

Uses existing canonical save routes and eligibility checks. Started games are disabled. Failed saves leave the selection available, duplicate submissions are blocked, Escape restores focus, and custom inputs survive refreshes. Newer main changes for stale-pick removal and password recovery were merged before final verification.

Validation: 86 backend tests; 259 existing logic/browser checks; 276 dedicated interaction assertions across 375, 390, 844, and 1440 px, including saving all 13 markets, book-specific lines, alternates, game lines, custom odds, failed saves, keyboard containment, restored focus, and overflow. All writes in UI tests are intercepted fixtures, never production picks.

Screenshots use illustrative fixtures: [game selection](previews/2026-09-09/super-lock-games.png), [prop selection](previews/2026-09-09/super-lock-props.png).

Reproduce: `node smoke/super-lock-panel.mjs /tmp/lock-league-super-lock`.
