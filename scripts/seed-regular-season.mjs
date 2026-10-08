// Independent GitHub-network fallback for the Cloudflare refresh.
import { pathToFileURL } from "node:url";
import { seedRegularSeason } from "../functions/_shared/scoreboard-refresh.js";
export { seedWeeks, seedRegularSeason } from "../functions/_shared/scoreboard-refresh.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedRegularSeason({ siteUrl: process.env.SITE_URL, cronSecret: process.env.CRON_SECRET })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
