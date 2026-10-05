# Zero-stat grading and Live game detail

Rashee Rice's Week 4 anytime-TD pick was pending because ESPN omitted him from the summary player box score. The event roster confirmed participation (`didNotPlay: false`), exact athlete identity matched, and detailed per-game stats explicitly contained zero for all six touchdown categories. Corrected Jacob's pick 2477 to L with a guarded, single-row update on October 5. No other picks changed.

Grading now falls back to ESPN's event roster and explicit game statistics only for a missing summary player in a final game. It verifies full identity and participation, requires every stat needed by the market, and leaves DNP, ambiguous, incomplete, or failed responses unresolved. Requests have a five-second total deadline and per-run player caching; normal grading uses no extra requests. This does not consume paid odds API credits.

Live expanded game details now have team logos, a larger scoreboard, an isolated pick-tracking section, readable team leader rows, and source freshness below. Existing result colors and grading behavior are preserved. No additional UI data requests.

Validation: 202 backend tests, 344 logic/render checks; dropdown browser fixtures at 375/768/1440px; actual Rice ESPN fallback returned L. Screenshots: [mobile](screenshots/live-game-panel/mobile.png), [desktop](screenshots/live-game-panel/desktop.png). `smoke/live-game-panel.mjs` is included in CI.
