# Lock League

NFL pick-league site for an 8-member group: historical browse (2023–25) + live in-season picks/lines/auto-grading starting 2026.

- **Members:** Brayden, Chase, Chris, Jack, Jacob, Jared, Mason, Tyler
- **Bet categories per week:** Favorite, Dog, Over, Under, Super 🔒

## Stack

- Static frontend (vanilla HTML/JS) served from `public/`
- **Cloudflare Pages Functions** in `functions/api/*.js` (Pages Functions `onRequest*` handlers)
- Deployed on **Cloudflare Pages** (`lock-league.pages.dev`); a push to `main` triggers the build
- Neon Postgres (`DATABASE_URL`) for live-season picks + games
- **SharpAPI** (FanDuel + DraftKings) for spreads/totals AND player props (`ODDS_PROVIDER=sharpapi`); The Odds API is the alternate provider
- ESPN scoreboard for final scores → auto-grading. ESPN 403s the CF colo IP, so the scoreboard is **seeded from a GitHub Actions runner** (`.github/workflows/*-seed.yml`)

## Routes

Cloudflare Pages maps each file under `functions/api/` to `/api/<name>`.

| Route | Function | Notes |
|-------|----------|-------|
| `/api/odds` | `odds.js` | NFL spreads + totals, FD + DK via SharpAPI; L1/L2/L3 cache + stale fallback. `?debug=props&market=<v>` samples raw prop rows |
| `/api/props` | `props.js` | Per-game player-prop menu for the Super Lock (SharpAPI, week-cached + last-good stale). `?debug=1` traces the pipeline |
| `/api/scores` | `scores.js` | Live scores for the current week (ESPN, cached) |
| `/api/warroom` | `warroom.js` | Sunday War Room: locked picks + live scores + consensus |
| `/api/auth?action=login\|logout\|me\|change-pass` | `auth.js` | Passphrase login, signed cookie, passphrase change |
| `/api/picks` | `picks.js` | GET season picks (others' hidden until the week locks); POST your week (locks Sun 12pm CT; a game locks at its kickoff) |
| `/api/grade` | `grade.js` | Manual fire (CRON_SECRET); grades current + previous week. Scheduled via GitHub Actions (`grade-cron.yml`): Thu/Sun/Mon/Tue windows |
| `/api/notify`, `/api/push`, `/api/settlement`, `/api/config` | resp. `.js` | Reminders/web-push, weekly settlement ledger, client bootstrap |

## History vs. live

- **2023–25** live in `data/seasons.json` (extracted from the original Google sheet)
- **2026+** lives in Neon Postgres (picks, games, grading)

Frontend reads static JSON for history and `/api/picks?season=2026` for the live season.

## CSS build

Tailwind is precompiled (no runtime CDN). After changing classes in
`public/index.html`, rebuild the stylesheet:

```
npm install
npm run build:css   # writes public/assets/tailwind.css — commit it
```

## Updating historical data

`python3 data/extract.py` (expects `/tmp/lock-league/lock-league.xlsx`).

Cell-color → outcome mapping in the source sheet:
- `93C47D` / `B6D7A8` → W (green)
- `E06666` → L (red)
- `FFD966` → P (push, yellow)

## Env vars

All set in the Cloudflare Pages project env (production):

| Name | Purpose |
|------|---------|
| `DATABASE_URL` | Neon Postgres connection |
| `SHARPAPI_KEY` | SharpAPI (odds + player props) |
| `ODDS_PROVIDER` | `sharpapi` (primary) or `theoddsapi` |
| `ODDS_API_KEY` / `ODDS_LIVE` | The Odds API key + live toggle (alternate provider) |
| `SESSION_SECRET` | HMAC for auth cookies |
| `CRON_SECRET` | Guards cron-only endpoints (`/api/grade`, seed, notify) |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | Web-push keys |
| `LL_TEST_MODE` | Time-windowed preseason dry-run flag (inert otherwise) |
| `DISCORD_WEBHOOK_URL` / `GROUPME_BOT_ID` | optional — grade runs post a week summary |

## Bootstrapping the DB

With `DATABASE_URL` pointed at the Neon database, initialize the schema (idempotent):

```
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" https://lock-league.pages.dev/api/init
```

This creates the schema, seeds 8 members with initial passphrases (`<name>2026`), and imports `data/seasons.json` into `picks`.
