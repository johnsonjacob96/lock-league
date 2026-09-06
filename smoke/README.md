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
| **logic** | `logic.mjs` | A 3-game Week 1 fed through `normalizeSharp` (board), `normalizeSharpProps` + `menuForGame` (props/alts), `deriveProp`/`deriveGradable` (pick anti-cheat), `findStartedGame`/`findMondayGame` (guards), the grading math (`gradeProp`/`gradeTotal`/`resolveSpreadResult`), **and the auto-grade router** `resolvePickResult` — the exact `bet_type` + `prop_meta` routing `gradeWeek` uses (spread vs total vs player-prop vs free-text→manual), with the box score injected. | Derivative-market leaks, prop mapping/alt gaps, anti-cheat holes, the −120 rule, guard regressions, mis-grading, and a pick routed to the wrong grader / free-text auto-graded. |
| **render** | `render.mjs` | Loads the real `index.html` headless, injects the simulated prop menu, and drives the Super Lock picker (every market + alt lines), War Room chip, and locked card at 1280/1024/500px. | JS errors on a data shape, layout/horizontal overflow, odds not showing, wrapping. |
| **live** | `live.mjs` | Read-only probes of the deployed endpoints. | Board serving leaked totals, props endpoint down/malformed, an endpoint 404/5xx after a deploy. Never writes. |

## Adding a case

- **New logic case** → add an assertion in `logic.mjs`; feed data via `fixtures.mjs`.
- **New market/prop type** → add rows to `fixtures.mjs::sharpPropRows()`; the logic + render layers pick it up.
- Fixtures mirror real SharpAPI/ESPN shapes (verified against production samples 2026-08-24). When a live shape surprises us, update the fixtures to match so the smoke test would have caught it.

## Week 1 readiness regressions (2026-09-06)

Use Node 24 for the additional suites:

```sh
npm ci
npm test                 # real PostgreSQL handler SQL via PGlite; ingestion, cache, props, cron
npm run smoke:render     # existing helper and viewport assertions
npm run smoke:browser    # real login/save/reload/remove against isolated PostgreSQL
npm run smoke:live       # deployed full Week 1 slate, markets and JSON endpoint checks
```

`npm test` never connects to production or sends notifications. The browser
workflow uses local handlers and an in-memory database, with provider responses
stubbed. It covers all eight login choices, persistence, outage feedback, mobile
layout, and navigation. It does not prove actual Web Push delivery or live
provider settlement. Browser screenshots are written to the OS temp directory.

Explicitly requested render/live layers now fail if they cannot run. The live
probe compares every upcoming eligible game against `week1-schedule.json`
(ESPN schedule verified September 6), and rejects HTML masquerading as an API.
Empty prop menus fail within 48 hours of kickoff; earlier availability is
provider-dependent. This is a Week 1 readiness probe, not a year-round monitor.

The existing Cloudflare preview environment lacks production SharpAPI/push
secrets and uses a different, unverified database connection. It is not a
production-equivalent provider test. Run integration tests locally; after
deploying, run live verification and seed
acknowledgment checks before declaring production ready.
