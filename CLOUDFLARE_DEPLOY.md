# Cloudflare Pages Deploy

One-time setup to migrate off the paused Netlify deployment.

## 1. Create the Pages project

In the Cloudflare dashboard:

1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Authorize GitHub, pick `johnsonjacob96/lock-league`
3. Production branch: `main`
4. **Build settings**: leave blank (no framework, no build command). Output directory: `/` (root).
5. Click **Save and Deploy** — the first build will fail until env vars are set, that's fine.

## 2. Set environment variables

**Settings → Environment variables** (Production):

| Name | Value |
|------|-------|
| `DATABASE_URL` | the Neon Postgres URL (copy from Netlify dashboard before it expires, or grab from Neon console) |
| `SESSION_SECRET` | the 64-char hex string used to sign session cookies (must match the one Netlify was using, or all current sessions invalidate) |
| `ODDS_API_KEY` | The Odds API key |
| `CRON_SECRET` | the 64-char hex string used to gate `/api/grade` and `/api/init` |
| `ODDS_LIVE` | `0` (set to `1` only during the live NFL window to burn Odds API credits) |

After saving, hit **Deployments** → most recent → **Retry deployment** so the env vars take effect.

## 3. Verify endpoints

```bash
SITE="https://lock-league.pages.dev"   # replace with actual subdomain after first deploy

# Should return { "member": null } (no session)
curl -s "$SITE/api/auth?action=me"

# Should return mock data (ODDS_LIVE=0)
curl -s "$SITE/api/odds" | head -c 500

# Should return 401 unauthorized (no secret)
curl -s "$SITE/api/grade"
```

## 4. Bootstrap the DB (one-time)

If this is a fresh Neon DB (i.e., not the same one Netlify was using):

```bash
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" "$SITE/api/init"
```

This creates the schema, seeds 8 members with `<name>2026` passphrases, and imports the historical 2,160 picks from `data/seasons.json`. Idempotent — safe to re-run.

> Note: the endpoint was renamed from `/api/_init` (Netlify) to `/api/init` since Cloudflare Pages Functions doesn't route filenames starting with `_`.

## 4b. Name a commissioner (one-time, for password recovery)

Members recover their own password from the sign-in screen ("Forgot password?"):
the app pushes a one-time code to the devices they've turned notifications on
for. A member with no registered device needs a commissioner to issue that code
for them, and nobody is a commissioner until you say so:

```bash
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Jacob"}' "$SITE/api/auth?action=set-admin"
```

That member then gets an **Issue a reset code** control in their Account modal;
they read the code out to whoever is locked out. Codes are single-use, expire in
20 minutes, and lock out after 5 wrong tries. Pass `{"name":"Jacob","admin":false}`
to take the role away.

There is no in-app way to grant the role — a stolen session can't promote
itself. Which also means the commissioner can't be reset from inside the app, so
recover them with the same secret:

```bash
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Jacob"}' "$SITE/api/auth?action=reset-issue"
```

The response carries the code; redeem it on the reset screen. Any successful
reset or password change also signs that member out everywhere else (it bumps
`members.session_epoch`, which every session cookie is stamped with).

## 5. Scheduling without a new platform token

The `lock-league-cron` Worker in `cron/` runs the app's quarter-hour clock:

- `/api/notify`: existing line-move, pick and kickoff reminder windows, plus
  grading and the Tuesday week close. Recipient, dedupe and time guards stay
  in the app.
- Direct ESPN scoreboard/boxscore refresh: quarter-hour during game windows,
  hourly otherwise, for the current and previous regular-season weeks. Tries
  ESPN's Cloudflare-reachable web host first; preserves final-stat checks.
- Hourly read-only homepage, config and scores health checks. Failures appear
  as failed Worker invocations and do not prevent other handlers from running.

**No new Cloudflare API token or GitHub personal access token is needed.**
Deploy using the existing Wrangler OAuth login and the existing encrypted
`CRON_SECRET`:

```bash
wrangler whoami
wrangler deploy --config cron/wrangler.toml
```

The Pages deployment and scheduler deployment are separate. Pushes to `main`
update Pages; they do **not** deploy the scheduler Worker. Existing Worker
secrets are preserved by `wrangler deploy`.

GitHub retains its runner-only daily coding agent and full browser/asset
monitor, plus `regular-season-seed.yml` as an independent-network ESPN
fallback. GitHub schedules are best-effort; the app no longer depends on
those schedules for its primary refresh, grading or reminder clock. Do not
remove the fallback unless its replacement has been verified from production.
The fallback runner still uses the existing `SITE_URL` and `CRON_SECRET`
Actions secrets. `grade-cron.yml` remains a manual "grade now" button.

Authenticated Worker diagnostics (send `X-Cron-Secret`, never put it in URLs):

- `?job=scoreboard&dryrun=1`: fetch/validate real ESPN data without writing.
- `?job=scoreboard`: refresh and verify snapshot persistence; no notification call.
- `?job=health`: read-only health checks.
- `?type=line-moves&dryrun=1`: existing notification eligibility check without sends.

Deploy and verify the Worker before merging changes that remove old schedules.
Four expired preseason workflows have been removed, including the annual
August `wipe-test` trigger that could have deleted real season-2026 Week 2 data.

An external Worker dispatching GitHub Actions would need separate runtime
GitHub authorization. A local `gh` OAuth login is not an identity installed in
Cloudflare; copying its broad token into a Worker is not our deployment model.
If runner jobs later need Cloudflare dispatch, use a repository-scoped GitHub
App rather than a personal token, and verify it before disabling any schedules.

## 6. Point the domain (optional)

If you want a custom domain instead of `lock-league.pages.dev`:

**Custom domains** → **Set up a custom domain** → enter the domain. Cloudflare handles DNS automatically if the domain is on Cloudflare; otherwise it gives you a CNAME target.

## Local development

```bash
npx wrangler pages dev --port 8765
```

Reads `wrangler.toml` plus a `.dev.vars` file (gitignored) for local env vars. Create `.dev.vars` with:

```
DATABASE_URL=postgres://...
SESSION_SECRET=...
ODDS_API_KEY=...
CRON_SECRET=...
ODDS_LIVE=0
```

## Rolling back to Netlify

The original `netlify/functions/*.mjs` and `netlify.toml` remain in the repo on the `cloudflare-migration` branch — they were not deleted. If we need to revert:

1. Get off Cloudflare: delete the Pages project (or just stop pointing the domain at it).
2. Resume Netlify: upgrade the team plan to lift the pause.
3. Re-point DNS.

No code revert is required since both function trees coexist.
