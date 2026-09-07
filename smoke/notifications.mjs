import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
let queries=[],sendCalls=[],claims=new Set(),rowsFor=()=>[];
mock.module('../functions/_shared/db.js',{namedExports:{sql:()=> (strings,...params)=>{
 const query=strings.join('?');queries.push(query);return Promise.resolve(rowsFor(query,params));
}}});
mock.module('../functions/_shared/push-notify.js',{namedExports:{
 pushPersonalized:async(_env,recipients,kind)=>{sendCalls.push({recipients,kind});return {sent:Object.keys(recipients).length,failed:0,pruned:0};},
 ensurePushTables:async()=>{queries.push('DDL ensurePushTables');},
 claimSend:async(_env,season,week,kind)=>{const key=`${season}:${week}:${kind}`;if(claims.has(key))return false;claims.add(key);return true;},
}});
mock.module('../functions/_shared/grader.js',{namedExports:{
 sameTeam:(a,b)=>a===b,pushWeekResults:async()=>{sendCalls.push('results');return {};},
}});
mock.module('../functions/_shared/migrations.js',{namedExports:{ensureExtras:async()=>{queries.push('DDL ensureExtras');}}});
const {onRequest}=await import('../functions/api/notify.js');
const env={CRON_SECRET:'test'};
const game={id:'opener',away:'New England Patriots',home:'Seattle Seahawks',kickoff:'2026-09-10T00:20:00Z',books:{fanduel:{spread:{fav:'Seattle Seahawks',line:-2.5}}}};
function setup(t,iso='2026-09-09T23:00:00Z'){
 queries=[];sendCalls=[];claims=new Set();rowsFor=()=>[];
 t.mock.timers.enable({apis:['Date'],now:Date.parse(iso)});
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(new URL(url).pathname,'/api/odds');return Response.json({games:[game]});});
}
async function call(type,query='dryrun=1',config=env){
 const response=await onRequest({env:config,request:new Request(`https://test.invalid/api/notify?type=${type}&${query}`,{headers:{'X-Cron-Secret':'test'}})});
 return {status:response.status,body:await response.json()};
}
function roster(){
 rowsFor=query=>query.includes('COUNT(p.id)')
  ? [{id:1,name:'Jacob',picks:1},{id:2,name:'Jared',picks:1},{id:3,name:'Chase',picks:1},{id:4,name:'Jack',picks:5}]
  : [{id:1,name:'Jacob',devices:2,notif_prefs:null},{id:2,name:'Jared',devices:1,notif_prefs:{reminder:false}},{id:3,name:'Chase',devices:0,notif_prefs:null}];
}
function noWritesOrSends(){assert.equal(sendCalls.length,0);assert.equal(claims.size,0);assert.ok(queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DDL)/i.test(q)));}

test('Wednesday opener reminder works at Sep9 23UTC and dryrun filters unsubscribed/opted-out members',async t=>{
 setup(t);roster();const result=await call('kickoff-reminder');
 assert.equal(result.status,200);assert.equal(result.body.week,1);assert.equal(result.body.games,1);
 assert.deepEqual(result.body.wouldRemind,['Jacob']);assert.equal(result.body.devices,2);noWritesOrSends();
});

test('kickoff delivery targets incomplete opted-in members once per game',async t=>{
 setup(t);roster();await call('kickoff-reminder','');await call('kickoff-reminder','');
 assert.equal(sendCalls.length,1);assert.deepEqual(Object.keys(sendCalls[0].recipients),['1']);
 assert.equal(sendCalls[0].kind,'reminder');assert.match(sendCalls[0].recipients[1].body,/7:20 PM CT/);
});

test('members with complete cards do not receive a kickoff reminder',async t=>{
 setup(t);rowsFor=query=>query.includes('COUNT(p.id)')?[{id:1,name:'Jacob',picks:5}]:[];
 await call('kickoff-reminder','');noWritesOrSends();
});

test('kickoff reminder never sends after kickoff or outside its two-hour window',async t=>{
 setup(t,'2026-09-10T00:21:00Z');roster();await call('kickoff-reminder','');noWritesOrSends();
 t.mock.timers.setTime(Date.parse('2026-09-09T20:00:00Z'));await call('kickoff-reminder','');noWritesOrSends();
});

test('line-move dryrun excludes started games and leaves alert state unchanged',async t=>{
 setup(t,'2026-09-11T12:00:00Z');
 const future={...game,away:'Dallas Cowboys',home:'New York Giants',kickoff:'2026-09-13T17:00:00Z'};
 t.mock.method(globalThis,'fetch',async()=>Response.json({games:[game,future]}));
 rowsFor=query=>query.includes('SELECT p.id')?[
 {id:1,member_id:1,name:'Jacob',bet_type:'Favorite',game_key:`${game.away}@${game.home}`,side:'fav',line:-4,alert_line:null},
 {id:2,member_id:1,name:'Jacob',bet_type:'Favorite',game_key:`${future.away}@${future.home}`,side:'fav',line:-4,alert_line:null},
 ]:[{id:1,name:'Jacob',devices:2,notif_prefs:null}];
 const result=await call('line-moves');assert.equal(result.body.picks,1);assert.deepEqual(result.body.wouldAlert,['Jacob']);noWritesOrSends();
});

test('results dryrun ignores reset and never claims or sends',async t=>{
 setup(t,'2026-09-13T18:00:00Z');rowsFor=query=>query.includes('FROM picks')?[{member_id:1,result:'W'}]:[{id:1,name:'Jacob',devices:1,notif_prefs:{results:false}}];
 const result=await call('results','dryrun=1&reset=1');assert.equal(result.body.ready,true);assert.equal(result.body.eligibleMembers,0);noWritesOrSends();
});

test('health checks real VAPID pair and subscription encryption without push requests, even before season start',async t=>{
 setup(t,'2026-09-07T12:00:00Z');
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
 const publicKey=await crypto.subtle.exportKey('raw',pair.publicKey);
 const subPair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const subscriptionPublic=await crypto.subtle.exportKey('raw',subPair.publicKey);
 rowsFor=()=>[{member_id:1,p256dh:Buffer.from(subscriptionPublic).toString('base64url'),auth:Buffer.alloc(16,5).toString('base64url'),notif_prefs:null}];
 const config={...env,VAPID_PUBLIC:Buffer.from(publicKey).toString('base64url'),VAPID_PRIVATE:privateJwk.d,VAPID_SUBJECT:'mailto:admin@example.invalid'};
 const result=await call('health','dryrun=1',config);
 assert.equal(result.body.keyPairValid,true);assert.equal(result.body.validSubscriptionKeys,1);assert.equal(result.body.ok,true);
 assert.equal(result.body.subscribedMembers,1);assert.deepEqual(result.body.enabledMembers,{reminder:1,lineMoves:1,results:1});noWritesOrSends();
 const badSubject=await call('health','dryrun=1',{...config,VAPID_SUBJECT:'invalid'});assert.equal(badSubject.body.subjectValid,false);assert.equal(badSubject.body.ok,false);
 const invalid=await call('health','dryrun=1',{...config,VAPID_PRIVATE:'invalid'});assert.equal(invalid.body.keyPairValid,false);assert.equal(invalid.body.ok,false);
});
