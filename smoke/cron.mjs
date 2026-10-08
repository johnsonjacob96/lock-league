import {test} from 'node:test';
import assert from 'node:assert/strict';
import cron, {nativeJobsDue, runNativeJob} from '../cron/src/index.js';
import {checkSite} from '../cron/src/health.js';
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
 const urls=[];t.mock.method(globalThis,'fetch',async (url,init)=>{if(new URL(url).pathname==='/api/notify')urls.push(new URL(url).searchParams.get('type'));return fixtureResponse(url,init);});
 for(const [date,expected] of [['2026-09-16T12:15:00Z',['line-moves']],['2026-09-16T16:00:00Z',['line-moves','reminder']],['2026-09-16T23:00:00Z',['line-moves','kickoff-reminder']],['2026-09-20T17:00:00Z',['line-moves','reminder']],['2026-09-16T17:00:00Z',['line-moves']]]){
  urls.length=0;let pending;await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse(date)},env,{waitUntil:p=>pending=p});await pending;assert.deepEqual(urls,expected);
 }
});

function fixtureResponse(input,init={}) {
 const url=new URL(input);
 if(url.pathname==='/')return new Response('<title>Lock League</title>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/api/config')return Response.json({season:2026,week:5});
 if(url.pathname==='/api/scores')return Response.json({games:[{home:'Home',away:'Away'}]});
 if(url.pathname.includes('scoreboard'))return Response.json({events:[{id:'1',status:{type:{state:'pre'}}}]});
 if(url.pathname==='/api/odds')return Response.json({ok:true,scoreboardSeeded:true,summariesSeeded:0});
 return Response.json({ok:true});
}
test('native planner covers games, hourly idle refresh, international games and offseason',()=>{
 for(const [date,jobs] of [
  ['2026-10-09T00:15Z',['scoreboard']],['2026-10-11T13:15Z',['scoreboard']],
  ['2026-10-12T05:45Z',['scoreboard']],['2026-10-08T18:00Z',['scoreboard','health']],
  ['2026-10-08T18:15Z',[]],['2026-06-01T18:00Z',['health']],['bad',[]],
 ])assert.deepEqual(nativeJobsDue(Date.parse(date)),jobs,date);
});
test('native seed uses reachable ESPN web host and dryrun never writes',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url:String(url),init});return fixtureResponse(url,init);});
 const result=await runNativeJob(env,'scoreboard',{now:Date.parse('2026-10-08T18:00Z'),dryrun:true});
 assert.equal(result.length,2);assert.ok(result.every(r=>r.dryrun));
 assert.ok(calls.every(r=>r.url.startsWith('https://site.web.api.espn.com/')&&!r.init?.method));
});
test('an ESPN outage does not block notifications or health checks, and the tick fails visibly',async t=>{
 const paths=[];t.mock.method(globalThis,'fetch',async(url,init)=>{paths.push(new URL(url).pathname);return String(url).includes('espn.com')?new Response('down',{status:503}):fixtureResponse(url,init);});
 let pending;await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse('2026-10-08T16:00Z')},env,{waitUntil:p=>pending=p});
 await assert.rejects(pending,/scoreboard unavailable/);
 assert.equal(paths.filter(p=>p==='/api/notify').length,2);assert.ok(paths.includes('/api/scores'));
 assert.ok(paths.every(p=>!p.includes('/dispatches')));
});
test('verification cron skips native writes and keeps notifications dry',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));return Response.json({ok:true});});
 let pending;await cron.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse('2026-10-08T16:00Z')},{...env,VERIFY_CRON:'*/15 * * * *'},{waitUntil:p=>pending=p});await pending;
 assert.equal(calls.length,2);assert.ok(calls.every(url=>url.includes('/api/notify')&&url.includes('dryrun=1')));
});
test('native job HTTP verification authenticates, rejects unknown jobs and surfaces failures',async t=>{
 assert.equal((await cron.fetch(new Request('https://test.invalid?job=scoreboard'),env)).status,401);
 const request=job=>new Request('https://test.invalid?job='+job,{headers:{'X-Cron-Secret':env.CRON_SECRET}});
 assert.equal((await cron.fetch(request('unknown'),env)).status,400);
 t.mock.method(globalThis,'fetch',async()=>new Response('down',{status:503}));
 assert.equal((await cron.fetch(request('health'),env)).status,502);
});
test('health rejects HTML fallback and bad config without skipping remaining probes',async t=>{
 const paths=[];t.mock.method(globalThis,'fetch',async url=>{const p=new URL(url).pathname;paths.push(p);return p==='/api/config'?Response.json({season:2026,week:99}):fixtureResponse(url);});
 await assert.rejects(checkSite(env.SITE_URL),/api\/config/);assert.equal(paths.length,3);
});

test('health uses Worker-compatible manual redirects and rejects redirect responses',async t=>{
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://example.invalid/login'}});});
 await assert.rejects(checkSite(env.SITE_URL),/302/);
});
