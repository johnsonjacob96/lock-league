# Compact Home, Picks, and Live

Owner approved the Home/Live concepts and compact My Card, while explicitly keeping the existing Picks matchup cards and team logos.

- Home puts the weekly summary and standings first, highlights the signed-in member, and uses a mobile season selector. Historical champions remain in a compact banner. Season highlights and weekly winners remain available below the table. The weekly pot uses existing payment configuration.
- Picks uses an expandable five-slot My Card and shorter deadline header; participation moves after the board on phones. Team-logo matchup cards and book toggles are unchanged. Native disclosure preserves an in-progress Super Lock through odds updates.
- Live puts the member's revealed active picks first, with logos, score, saved price, and selected-prop progress. Existing league cards and drill-downs remain below. Settled units exclude projections, missed slots, and unpriced results; missing odds are labeled. Hidden picks are not exposed early.
- Mobile navigation: Home, Picks, Live, More. More contains Payments, Lifetime, Rules, and Account. The tape is hidden on the three primary screens.
- Existing 2026 kickoff rollover is unchanged. Home uses settled season data; detailed in-game progress is on Live.

## Validation

- 72 backend tests passed.
- 223 logic/browser checks passed, including draft preservation, disclosure state, unit accounting, hidden picks, full prop titles, and responsive standings.
- `node smoke/design-preview.mjs` renders isolated fixtures at 375, 390, 844, and 1440 pixels; asserts no overflow, no browser errors, and four-item navigation with secondary destinations.
- Fixtures intercept API calls. No production picks, payments, or notifications are changed by preview generation.

## Rendered test snapshots

Illustrative Sunday data, not actual season results:

- [Home](previews/2026-09-07/home.png)
- [Picks](previews/2026-09-07/picks.png)
- [Live](previews/2026-09-07/live.png)

Regenerate snapshots with `node smoke/design-preview.mjs /tmp/lock-league-design`.
