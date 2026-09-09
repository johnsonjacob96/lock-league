# Code organization refactor

Baseline: deployed `10130aa`. The separate local game-line-per-book branch is left untouched. This release changes code organization and test wiring; existing UI, API contracts, selection rules, cache TTLs, fallback sequence, payments, grading, and notifications are preserved.

## Boundaries

- `public/assets/super-lock.js`: active panel rendering, selection, photos, binding and saving. All panel state is in `superLockState`. Kept as a classic script to preserve the existing application's loading/integration model; application helpers are resolved when called.
- `public/assets/super-lock.css`: consolidated panel styles, preserving shorthand/longhand and responsive behavior. Retired dropdown styles/renderer/bindings and exclusive best-side helpers removed.
- `functions/_shared/odds-providers.js`: provider fetch/normalization and week scoping.
- `functions/_shared/odds-diagnostics.js`: existing diagnostics, called only after the same endpoint authorization gate.
- `functions/api/odds.js`: HTTP entry points, quota protection, caching, supplementation, snapshots and fallback orchestration. Existing normalization exports retained for consumers/tests.
- `public/data/nfl-teams.json`: authoritative ESPN logo/roster identifiers. `npm run build:data` generates the browser binding; the photo refresh script reads JSON directly. CI verifies generated data stays synchronized. Provider canonical-name aliases are intentionally unchanged.

## Verification

86 backend tests; 281 logic/render checks; 336 dedicated Super Lock interaction assertions; 40 handler/browser checks. The active picker suite is now included in CI and `smoke:all`, resolves local Playwright, closes resources on failure, and uses checked-in portrait fixtures.

Before/after captures cover Home, Picks, Live, participant comparison, champion and Super Lock game/prop/yardage views at four widths. 26 of 32 captures were pixel-identical. The remaining comparisons differed in at most 1,103 pixels out of 1,324,800 (under 0.09%), primarily logo/focus edge rendering; paired visual inspection found no layout or component loss. All primary prop-selection captures were pixel-identical. Tailwind rebuilding produces unchanged CSS.

The frontend HTML is reduced by roughly 600 lines; the odds endpoint is reduced from 825 to roughly 375 lines. New files are formatted for review rather than optimized for line count.
