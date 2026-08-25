# Week-1 smoke suite

A simulated end-to-end test that runs a full NFL Week 1 through the **real app
logic** to surface bugs before they reach the league. Built after a run of live
Week-1 issues (team totals leaking onto the board, props pointed at the wrong
SharpAPI market, alt lines, odds display, the card scroll/overflow).

## Run it

```bash
npm run smoke          # logic layer only — fast, no deps, no network (CI default)
npm run smoke:render   # + client render smoke (needs Playwright)
npm run smoke:live     # + live prod health probe (network, read-only)
npm run smoke:all      # everything
# probe a preview deploy:
node smoke/run.mjs --live --url=https://<preview>.pages.dev
```

Exit code is non-zero if any check fails. CI (`.github/workflows/smoke.yml`) runs
**logic** + **render** on every push to `main` and on PRs; the **live** probe is
opt-in via manual dispatch (or run it locally before go-live).

## Layers

| Layer | File | What it simulates | Catches |
|-------|------|-------------------|---------|
| **logic** | `logic.mjs` | A 3-game Week 1 fed through `normalizeSharp` (board), `normalizeSharpProps` + `menuForGame` (props/alts), `deriveProp`/`deriveGradable` (pick anti-cheat), `findStartedGame`/`findMondayGame` (guards), and `gradeProp`/`gradeTotal`/`resolveSpreadResult` (grading). | Derivative-market leaks, prop mapping/alt gaps, anti-cheat holes, the −120 rule, guard regressions, mis-grading. |
| **render** | `render.mjs` | Loads the real `index.html` headless, injects the simulated prop menu, and drives the Super Lock picker (every market + alt lines), War Room chip, and locked card at 1280/1024/500px. | JS errors on a data shape, layout/horizontal overflow, odds not showing, wrapping. |
| **live** | `live.mjs` | Read-only probes of the deployed endpoints. | Board serving leaked totals, props endpoint down/malformed, an endpoint 404/5xx after a deploy. Never writes. |

## Adding a case

- **New logic case** → add an assertion in `logic.mjs`; feed data via `fixtures.mjs`.
- **New market/prop type** → add rows to `fixtures.mjs::sharpPropRows()`; the logic + render layers pick it up.
- Fixtures mirror real SharpAPI/ESPN shapes (verified against production samples 2026-08-24). When a live shape surprises us, update the fixtures to match so the smoke test would have caught it.
