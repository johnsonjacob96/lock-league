# Full-game market validation

The DK Miami/San Francisco 9.5 total fix previously existed only on preview commit `70a6622`. This release includes that containment and closes the two gaps found in the follow-up audit.

- SharpAPI board normalization recognizes an explicit set of full-game spread/points-total aliases, normalizing case and separators without removing period/team qualifiers. Unknown markets are withheld even if they carry `is_main_line` and a plausible number. Supported aliases and independent FD/DK quotes have regression coverage.
- Conservative 28–75 total and ±30 spread safety limits apply before main-line selection, on board output, and when deriving ordinary or game-line Super Lock picks. These are safety heuristics, not universal historical bounds or substitutes for market identity.
- The public odds handler sanitizes after the outer shared cache returns, covering fresh and stale payloads that bypass the loader. Bad cached totals are removed without losing the other book's valid total or the affected book's valid spread.
- Unknown total selection directions are discarded instead of silently becoming Under.
- A side without a price is visibly disabled, matching existing server eligibility.

Validation: 167/167 backend tests; 344/344 logic/render checks at 390, 1024 and 1280px. Added `smoke/dk-incident-audit.mjs` to `npm test`; it exercises the real public handler with fresh/stale cache hits as well as in-range derivative rejection. Mobile unpriced-side rendering visually inspected.

No schema, historical pick, grading, provider subscription, or polling changes. No test picks or notifications sent. The original historical vendor row is unavailable, so the specific derivative that produced 9.5 remains unconfirmed. Unsupported market aliases intentionally remain unavailable pending explicit validation. Numeric sanitation cannot identify an already-normalized in-range derivative in an old snapshot; new upstream ingestion uses strict market identification.
