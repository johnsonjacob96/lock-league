import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function fixture(probe, response) {
  const dir = await mkdtemp(join(tmpdir(), 'site-watch-test-'));
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<title>Fixture site</title>'); }
    res.statusCode = response.status || 200;
    res.setHeader('content-type', response.type || 'application/json');
    res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await copyFile(new URL('./check.mjs', import.meta.url), join(dir, 'check.mjs'));
    await writeFile(join(dir, 'site.json'), JSON.stringify({name:'Fixture',title:'Fixture site',url:`http://127.0.0.1:${server.address().port}`,probes:[{path:'/data',...probe}]}));
    let code = 0;
    try { await exec(process.execPath, ['check.mjs'], {cwd:dir,env:{...process.env,GITHUB_STEP_SUMMARY:''},timeout:10000}); }
    catch (e) { code = e.code; }
    const report = JSON.parse(await readFile(join(dir, 'monitor-output/results.json')));
    return { code, report };
  } finally { server.close(); await rm(dir, {recursive:true,force:true}); }
}
test('accepts a completed season without requiring live tournament data', async () => {
  const r = await fixture({kind:'season'}, {body:{year:2026,owners:{one:{}},events:[{}],seasonComplete:true}});
  assert.equal(r.code, 0);
});
test('rejects an HTTP 200 HTML fallback for a JSON endpoint', async () => {
  const r = await fixture({kind:'health'}, {type:'text/html',body:'<title>Fixture site</title>'});
  assert.equal(r.code, 1);
  assert.match(r.report.results[1].error, /Expected JSON/);
});
test('rejects production mock odds even when the endpoint returns 200', async () => {
  const r = await fixture({kind:'odds'}, {body:{source:'mock',games:[]}});
  assert.equal(r.code, 1);
  assert.match(r.report.results[1].error, /Mock odds/);
});
test('rejects a protected endpoint that unexpectedly allows anonymous access', async () => {
  const r = await fixture({kind:'auth',status:401}, {body:{holdings:[]}});
  assert.equal(r.code, 1);
  assert.match(r.report.results[1].error, /Expected HTTP 401/);
});
