import {test} from 'node:test';
import assert from 'node:assert/strict';
import cron from '../cron/src/index.js';
const env={SITE_URL:'https://test.invalid',CRON_SECRET:'test-only'};
test('scheduler rejects missing or wrong shared secret',async()=>{
 assert.equal((await cron.fetch(new Request('https://test.invalid'),{})).status,401);
 assert.equal((await cron.fetch(new Request('https://test.invalid'),env)).status,401);
});
test('scheduler surfaces failed notification endpoint',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('unavailable',{status:503}));
 let pending;await cron.scheduled({cron:'0 17 * * SUN'},env,{waitUntil:p=>pending=p});
 await assert.rejects(pending,/503/);
});
test('shared schedule fires both configured handlers; verification remains dry run',async t=>{
 const requests=[];t.mock.method(globalThis,'fetch',async(url,init)=>{requests.push({url,init});return Response.json({ok:true,dryrun:true});});
 let pending;await cron.scheduled({cron:'0 16 * * *'},{...env,VERIFY_CRON:'0 16 * * *'},{waitUntil:p=>pending=p});await pending;
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.url.includes('dryrun=1')&&r.init.headers['X-Cron-Secret']===env.CRON_SECRET));
});
