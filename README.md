# Lock League

NFL pick-league site for an 8-member group: historical browse (2023–25) + live in-season picks/lines/auto-grading starting 2026.

- **Members:** Brayden, Chase, Chris, Jack, Jacob, Jared, Mason, Tyler
- **Bet categories per week:** Favorite, Dog, Over, Under, Super 🔒

## Stack

- Static frontend (vanilla HTML/JS) at the repo root
- Netlify Functions in `netlify/functions/*.mjs` (v2 / standard `Request`/`Response`)
- Neon Postgres (via Netlify Neon extension) for live-season picks + games
- The Odds API for FanDuel + DraftKings spreads/totals
- ESPN scoreboard for final scores → auto-grading via scheduled function

## Routes

| Route | Function | Notes |
|-------|----------|-------|
| `/api/odds` | `odds.mjs` | NFL spreads + totals, FD + DK, 5-min cache, mock fallback |
| `/api/auth?action=login\|logout\|me` | `auth.mjs` | Passphrase login, signed cookie |
| `/api/picks` | `picks.mjs` | GET season picks (others' picks hidden until the week locks); POST your week (locks Sun 12am CT) |
| `/api/grade` | `grade.mjs` | Manual fire (CRON_SECRET); default grades current + previous week. Scheduled runs: Fri (TNF), Sun (early), Mon ×2 (late/SNF), Tue (MNF) |

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

| Name | Where | Purpose |
|------|-------|---------|
| `ODDS_API_KEY` | Netlify | The Odds API |
| `SESSION_SECRET` | Netlify | HMAC for auth cookies |
| `CRON_SECRET` | Netlify | Manual `/api/grade` fire |
| `NETLIFY_DATABASE_URL` | injected by Neon extension | Postgres connection |

## Bootstrapping the DB

After Neon is provisioned and `NETLIFY_DATABASE_URL` is set:

```
DATABASE_URL=$NETLIFY_DATABASE_URL node scripts/init-db.js all
```

This creates the schema, seeds 8 members with initial passphrases (`<name>2026`), and imports `data/seasons.json` into `picks`.
