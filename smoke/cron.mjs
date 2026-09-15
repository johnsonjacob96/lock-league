import {test} from 'node:test';
import assert from 'node:assert/strict';
import cron from '../cron/src/index.js';
const env={SITE_URL:'https://test.invalid',CRON_SECRET:'test-only'};
test('combined daily cron preserves morning and evening notification types',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async url=>{urls.push(url);return Response.json({ok:true});});
 for(const [hour,types] of [[16,['reminder','line-moves']],[23,['line-moves','kickoff-reminder']]]){
  urls.length=0;let pending;
  await cron.scheduled({cron:'0 16,23 * * *',scheduledTime:Date.UTC(2026,8,15,hour)},env,{waitUntil:p=>pending=p});await pending;
  assert.deepEqual(urls.map(url=>new URL(url).searchParams.get('type')),types);
 }
});
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

test('evening scheduler includes the Wednesday kickoff reminder without another cron slot',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async url=>{urls.push(url);return Response.json({ok:true});});
 let pending;await cron.scheduled({cron:'0 23 * * *'},env,{waitUntil:p=>pending=p});await pending;
 assert.equal(urls.length,2);assert.ok(urls.some(url=>url.includes('type=kickoff-reminder')));
});
