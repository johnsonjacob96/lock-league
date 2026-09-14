import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
let rows=[],messages=[],claims=0;
mock.module('../functions/_shared/db.js',{namedExports:{ignoringConcurrentCreate:p=>p,sql:()=> (strings)=>Promise.resolve(strings.join('').includes('FROM members') ? [{id:1,name:'Jacob'},{id:2,name:'Jared'}] : rows)}});
mock.module('../functions/_shared/push-notify.js',{namedExports:{
 claimSend:async()=>{claims++;return true;},
 pushPersonalized:async(_env,recipients)=>{messages.push(recipients);return {sent:2};},
}});
const {pushWeekResults}=await import('../functions/_shared/grader.js');
const bets=['Favorite','Dog','Over','Under','Super Lock'];
const card=(id,price)=>bets.map((bet_type,i)=>({member_id:id,week:1,bet_type,result:['W','W','L','L','W'][i],price:bet_type==='Super Lock'?price:-110}));
test('winner notification uses Article 7 rather than alphabetical order or tied W/L',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-16T00:00Z')});
 rows=[...card(1,150),...card(2,250)];messages=[];claims=0;
 t.mock.method(globalThis,'fetch',()=>{throw Error('No real messages allowed');});
 const result=await pushWeekResults({},2026,1);
 assert.equal(result.winner,'Jared');assert.equal(claims,1);
 assert.equal(messages[0][2].title,'You won Week 1');
 assert.match(messages[0][1].body,/Jared won the week/);
});
test('pending current-week picks never claim a winner notification',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-16T00:00Z')});
 rows=[...card(1,150),...card(2,250)];rows[9].result=null;messages=[];claims=0;
 assert.deepEqual(await pushWeekResults({},2026,1),{skipped:'pending-results'});
 assert.equal(claims,0);assert.equal(messages.length,0);
});
