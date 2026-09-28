# Live result clarity

Live cards and their measured-progress bars use a shared presentation state:

- Settled win: green, WON. Settled loss: red, LOST. Push: amber, PUSH.
- Live over above its line or anytime TD recorded: green, TARGET REACHED · LIVE.
- Live under above its limit: red, OVER LIMIT · LIVE.
- Unreached overs, unders still below the limit, equality, and all unfinished spreads: neutral.
- Missing/ambiguous stats and explicitly stale feeds do not create threshold signals.

Threshold colors describe recorded progress; they never grade a pick or change standings. Live stat corrections can reverse a threshold signal. Final/ungraded props say AWAITING GRADE. Final results take precedence over cached progress.

Completed personal picks remain in the detailed card, after open picks. Final prop details load if missing and stop refreshing once final stats are cached. League rows also have readable WON / LOST / PUSH badges; entire participant cards are not recolored. No provider or polling-cadence changes.

Validation: 186 backend tests, 344 logic/render checks, plus dedicated live-result browser coverage at 375/844/1440px (22 state/render checks per width, computed colors, overflow, enlarged text, reduced motion). Regression scenarios include unders, exact lines, zero lines, touchdowns, game-line Super Locks, stale/duplicate/missing player stats, and final grade precedence.

Fixture screenshots: [mobile](screenshots/live-results/mobile.png), [desktop](screenshots/live-results/desktop.png). These are simulated picks, not production records. Fonts are blocked in deterministic browser testing.
