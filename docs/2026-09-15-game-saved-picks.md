# Saved picks on game cards

Picks game cards now display a compact blue “ON YOUR CARD” strip with the saved category, sportsbook and bet text. It is independent of the displayed book and current quote: a DraftKings Packers +2.5 selection remains visible while viewing FanDuel +1.5, even when the DK line has moved. Includes all game-linked standard picks and Super Locks, including multiple picks on a matchup. No inferred game links for free-text custom locks.

Existing exact-quote button selection and replacement confirmation remain unchanged. Indicators refresh on load, saves, removals, book switches and quote refreshes. They represent selections, not wins. No API requests, persistence or grading changes.

Validation: new 390/1440 browser tests cover book switching, moved lines, Super Lock inclusion, missing books, started games, removal/replacement and sign-out. CI runs these with existing smoke suites. [Illustrative card preview](previews/2026-09-15/game-saved-picks.png).

Owner color preference: FanDuel saved rows use blue, DraftKings green. Each row carries its own book tint/border and explicit FD/DK label, so mixed-book games show both. Outer container is neutral; unrecognized/missing books use neutral styling. These colors identify sportsbooks, not results. Updated mobile preview and existing 390/1440 browser checks verified.
