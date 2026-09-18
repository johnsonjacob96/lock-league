import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('./site.json', import.meta.url)));
await mkdir('monitor-output', { recursive: true });
const results = [];
async function check(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}
async function request(url, status = 200) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'User-Agent': 'SiteWatch/1.0' } });
  assert.equal(r.status, status, `Expected HTTP ${status}; got ${r.status}`);
  return r;
}
async function retry(run) {
  try { return await run(); }
  catch { await new Promise(r => setTimeout(r, 2000)); return run(); }
}
await check('Homepage identity', () => retry(async () => {
  const r = await request(config.url);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), new RegExp(config.title, 'i'), 'Expected site identity missing');
}));
for (const probe of config.probes) await check(probe.path || probe.url, () => retry(async () => {
  const r = await request(probe.url || config.url + probe.path, probe.status || 200);
  assert.match(r.headers.get('content-type') || '', /application\/json/, 'Expected JSON, not an HTML fallback');
  const data = await r.json();
  assert.ok(data && typeof data === 'object', 'Missing JSON object');
  if (probe.kind === 'health') assert.equal(data.ok, true);
  if (probe.kind === 'auth') assert.ok(data.error, 'Missing auth rejection');
  if (probe.kind === 'config') {
    assert.ok(Number.isInteger(Number(data.season)) && Number(data.season) >= 2026, 'Invalid season');
    assert.ok(Number.isInteger(Number(data.week)) && Number(data.week) >= 0 && Number(data.week) <= 22, 'Invalid week');
  }
  if (probe.kind === 'odds') {
    assert.ok(Array.isArray(data.games), 'Missing games array');
    assert.notEqual(data.source, 'mock', 'Mock odds in production');
    // An empty slate is valid off-season. Richer freshness checks need the league calendar.
    for (const game of data.games) assert.ok(game.home && game.away, 'Missing game identity');
  }
  if (probe.kind === 'snapshot') {
    const age = Date.now() - Date.parse(data.updated);
    assert.ok(Number.isFinite(age) && age >= -3600000, 'Invalid snapshot timestamp');
    const month = new Date().getUTCMonth();
    // Daily refresh is configured September–January. Allow two missed runs before failing.
    if (month >= 8 || month === 0) assert.ok(age < 72 * 3600000, 'Snapshot is over 72 hours old during NFL season');
  }
  if (probe.kind === 'season') {
    assert.ok(Number.isInteger(data.year), 'Missing season year');
    assert.ok(Array.isArray(data.events) && data.events.length > 0, 'Missing season events');
    assert.ok(data.owners && Object.keys(data.owners).length > 0, 'Missing owners');
    // Completed seasons stay valid; do not demand fresh scores between majors.
  }
}));
// A deploy that reports success but still serves the previous bundle looks
// exactly like a healthy site: every probe above passes against stale code.
// Compare what production returns with what is committed here and say so.
for (const path of config.assets || []) await check(`asset ${path}`, () => retry(async () => {
  const r = await request(config.url + path);
  const digest = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const served = digest(await r.arrayBuffer());
  // Pages serves the site root from index.html and redirects the explicit
  // filename to it, so ask for the path visitors actually load.
  const file = path.endsWith('/') ? path + 'index.html' : path;
  const committed = digest(await readFile(new URL('../../public' + file, import.meta.url)));
  assert.equal(served, committed, `Production is serving a different ${path} than this commit (served ${served.slice(0, 12)}, committed ${committed.slice(0, 12)}) — the deploy is stale or was skipped`);
}));

if (process.argv.includes('--browser')) {
  await check('Browser setup and public routes', async () => {
    const { chromium } = await import('../../.monitor-runtime/node_modules/playwright/index.mjs');
    const browser = await chromium.launch();
    try {
      for (const width of [390, 1440]) for (const route of config.routes) {
        await check(`${route.path} at ${width}px`, async () => {
          const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(e.message));
          page.on('dialog', d => d.dismiss());
          // Public browsing only. Prevent incidental production writes from page scripts.
          await context.route('**/*', r => ['GET', 'HEAD', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort());
          try {
            const response = await page.goto(config.url + route.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
            assert.equal(response?.status(), 200);
            await page.locator(route.selector).first().waitFor({ state: 'visible', timeout: 30000 });
            await page.waitForTimeout(1500);
            assert.match(await page.title(), new RegExp(config.title, 'i'));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Horizontal page overflow');
            assert.deepEqual(errors, [], 'Uncaught browser errors');
          } finally {
            await page.screenshot({ path: `monitor-output/${width}-${config.routes.indexOf(route)}.png`, fullPage: true }).catch(() => {});
            await context.close();
          }
        });
      }
    } finally { await browser.close(); }
  });
}
const report = { site: config.name, checkedAt: new Date().toISOString(), results };
await writeFile('monitor-output/results.json', JSON.stringify(report, null, 2));
const summary = `## ${config.name} monitoring\n\n` + results.map(r => `- ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`).join('\n') + '\n';
await writeFile('monitor-output/report.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (results.some(r => !r.ok)) process.exitCode = 1;
