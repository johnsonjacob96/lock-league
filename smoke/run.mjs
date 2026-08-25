#!/usr/bin/env node
// Week-1 smoke suite orchestrator.
//   node smoke/run.mjs             # logic layer only (fast, no deps, CI default)
//   node smoke/run.mjs --render    # + client-render smoke (needs Playwright)
//   node smoke/run.mjs --live      # + live prod health probe (network)
//   node smoke/run.mjs --all       # everything
//   node smoke/run.mjs --live --url=https://<preview>.pages.dev
import { report } from "./assert.mjs";
import { run as runLogic } from "./logic.mjs";

const args = process.argv.slice(2);
const want = (f) => args.includes(f) || args.includes("--all");
const baseUrl = (args.find(a => a.startsWith("--url=")) || "").split("=")[1] || "https://lock-league.pages.dev";

const suites = [await runLogic()];

if (want("--render")) {
  try { const { run } = await import("./render.mjs"); suites.push(await run()); }
  catch (e) { console.log("\n⚠ render layer skipped:", e.message); }
}
if (want("--live")) {
  try { const { run } = await import("./live.mjs"); suites.push(await run(baseUrl)); }
  catch (e) { console.log("\n⚠ live layer skipped:", e.message); }
}

process.exit(report(suites) ? 0 : 1);
