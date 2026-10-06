import {test} from 'node:test';
import assert from 'node:assert/strict';
import cron,{githubJobsDue} from '../cron/src/index.js';
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


test('quarter-hour schedule checks lines and preserves original reminder slots',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async url=>{urls.push(new URL(url).searchParams.get('type'));return Response.json({ok:true});});
 for(const [date,expected] of [['2026-09-16T12:15:00Z',['line-moves']],['2026-09-16T16:00:00Z',['line-moves','reminder']],['2026-09-16T23:00:00Z',['line-moves','kickoff-reminder']],['2026-09-20T17:00:00Z',['line-moves','reminder']],['2026-09-16T17:00:00Z',['line-moves']]]){
  urls.length=0;let pending;await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse(date)},env,{waitUntil:p=>pending=p});await pending;assert.deepEqual(urls,expected);
 }
});

test('GitHub jobs run on this clock: seed every tick in game windows, hourly otherwise, never off-season',()=>{
 const due=iso=>githubJobsDue(Date.parse(iso)).map(j=>j.workflow+(j.inputs?' '+j.inputs.browser:''));
 assert.deepEqual(due('2026-10-04T18:15:00Z'),['regular-season-seed.yml'],'Sunday afternoon: every tick');
 assert.deepEqual(due('2026-10-06T02:45:00Z'),['regular-season-seed.yml'],'Monday night (Tue UTC)');
 assert.deepEqual(due('2026-10-02T00:30:00Z'),['regular-season-seed.yml'],'Thursday night (Fri UTC)');
 assert.deepEqual(due('2026-10-07T15:15:00Z'),[],'no game on, not on the hour');
 assert.deepEqual(due('2026-10-07T15:00:00Z'),['regular-season-seed.yml','site-monitor.yml false'],'hourly heartbeat and API monitor');
 assert.deepEqual(due('2026-10-07T11:30:00Z'),['site-monitor.yml true'],'daily browser monitor');
 assert.deepEqual(due('2026-10-07T12:15:00Z'),['daily-improvement.yml']);
 assert.deepEqual(due('2026-07-04T15:00:00Z'),['site-monitor.yml false'],'no seed between seasons');
});
test('a tick dispatches due workflows to GitHub on main, alongside its notifications',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url:String(url),init});return String(url).startsWith('https://api.github.com')?new Response(null,{status:204}):Response.json({ok:true});});
 const pending=[];await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse('2026-10-07T15:00:00Z')},{...env,GH_DISPATCH_TOKEN:'gh-test'},{waitUntil:p=>pending.push(p)});await Promise.all(pending);
 const gh=calls.filter(c=>c.url.startsWith('https://api.github.com'));
 assert.deepEqual(gh.map(c=>c.url),['https://api.github.com/repos/johnsonjacob96/lock-league/actions/workflows/regular-season-seed.yml/dispatches','https://api.github.com/repos/johnsonjacob96/lock-league/actions/workflows/site-monitor.yml/dispatches']);
 assert.deepEqual(gh.map(c=>JSON.parse(c.init.body)),[{ref:'main'},{ref:'main',inputs:{browser:'false'}}]);
 assert.ok(gh.every(c=>c.init.method==='POST'&&c.init.headers.Authorization==='Bearer gh-test'&&c.init.headers['User-Agent']));
 assert.ok(calls.some(c=>c.url.includes('type=line-moves')),'notifications still fire');
});
test('no token, a dry run, or a GitHub failure never blocks notifications',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));return String(url).startsWith('https://api.github.com')?new Response('nope',{status:403}):Response.json({ok:true});});
 const tick=async(extra)=>{const pending=[];await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse('2026-10-07T15:00:00Z')},{...env,...extra},{waitUntil:p=>pending.push(p)});await Promise.all(pending);};
 await tick({});
 assert.equal(calls.filter(u=>u.startsWith('https://api.github.com')).length,0,'no token: nothing dispatched');
 calls.length=0;await tick({GH_DISPATCH_TOKEN:'gh-test',VERIFY_CRON:'*/15 * * * *'});
 assert.equal(calls.filter(u=>u.startsWith('https://api.github.com')).length,0,'dry run: nothing dispatched');
 calls.length=0;await tick({GH_DISPATCH_TOKEN:'gh-test'});
 assert.equal(calls.filter(u=>u.startsWith('https://api.github.com')).length,2,'both attempted');
 assert.ok(calls.some(u=>u.includes('type=line-moves')),'a 403 from GitHub does not stop notifications');
});
