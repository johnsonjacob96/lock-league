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

## 5. Set up GitHub Actions cron

In the GitHub repo: **Settings → Secrets and variables → Actions** → add:

- `SITE_URL` → `https://lock-league.pages.dev` (or your custom domain)
- `CRON_SECRET` → same value as the Cloudflare env var

The workflow at `.github/workflows/grade-cron.yml` will then fire 4x/week at the same UTC times as the old Netlify scheduled functions.

To test the workflow manually: **Actions tab → Grade Picks (cron) → Run workflow**.

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
