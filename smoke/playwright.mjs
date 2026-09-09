// CI installs Playwright locally; developer machines may use a global install.
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
export async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {}
  const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
  return (await import(pathToFileURL(root + "/playwright/index.mjs").href))
    .chromium;
}
