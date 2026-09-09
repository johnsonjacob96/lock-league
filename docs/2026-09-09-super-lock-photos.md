# Super Lock portraits and total sorting

The Super Lock game list now shows each matchup's highest available FanDuel/DraftKings game total and sorts descending. Ties use kickoff time; missing totals follow priced games, and started games remain last and disabled.

Player rows now load verified ESPN portraits from a bundled lookup of 2,481 roster athletes across all 32 teams. Matching normalizes punctuation, accents, and suffixes, prefers the selected game's teams, and rejects ambiguous identities or non-ESPN photo URLs. Initials remain visible while loading and after an image error. Loading portraits patches only the avatar, preserving the user's selection and scroll.

No new sportsbook calls or runtime ESPN roster requests. Refresh the bundled data with `node scripts/update-player-photos.mjs`; it uses 32 roster requests with four concurrent workers and preserves the old file if a roster fails. The current lookup is a deployment snapshot, not a scheduled roster sync.

Validation: 259 existing logic/browser checks and 292 Super Lock browser assertions across 375/390/844/1440 px. Covers all-market saving plus highest-total ordering, ties, missing totals, started games, actual Jalen Hurts photo identity/load, image failure, ambiguous identity, and unsafe URL fallback. No production picks submitted.

Screenshots: [photos](previews/2026-09-09/super-lock-photos.png), [totals](previews/2026-09-09/super-lock-totals.png).
