// A finished week must close (winner crowned, results pushed) on the first
// scheduler tick after it ends, without waiting for GitHub's Tuesday cron.
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
function sql(){return (strings,...params)=>db.query(strings.reduce((q,s,i)=>q+(i?'$'+i:'')+s,''),params).then(r=>r.rows);}
mock.module('../functions/_shared/db.js',{namedExports:{sql,ignoringConcurrentCreate:p=>p}});
mock.module('../functions/_shared/push-notify.js',{namedExports:{
 ensurePushTables:async()=>{},claimSend:async()=>true,pushPersonalized:async()=>({sent:0,failed:0,pruned:0}),
}});
const {gradingDue,scheduledGrade}=await import('../functions/_shared/grader.js');
await db.exec(`CREATE TABLE picks(id serial PRIMARY KEY,member_id int,season int,week int,bet_type text,game_key text,result text);
 CREATE TABLE week_notifications(season int,week int,kind text,sent_at timestamptz DEFAULT NOW(),PRIMARY KEY(season,week,kind));`);
const card=async(week,results,{gameKey='Dallas Cowboys@New York Giants'}={})=>{for(const [i,result] of results.entries())await db.query('INSERT INTO picks(member_id,season,week,bet_type,game_key,result) VALUES(1,2026,$1,$2,$3,$4)',[week,['Favorite','Dog','Over','Under','Super Lock'][i],gameKey,result]);};
const reset=()=>db.exec('DELETE FROM picks;DELETE FROM week_notifications');
// Week 4 = Tue Sep 29 08:00 UTC -> Tue Oct 6 08:00 UTC.
const sundayNight=new Date('2026-10-05T05:00:00Z'),tuesdayMorning=new Date('2026-10-06T09:00:00Z');

test('a fully graded week closes on the first tick after the season rolls past it',async()=>{
 await reset();await card(4,['W','L','W','W','L']);
 assert.equal(await gradingDue({},sundayNight),false,'nothing to grade, and the week is still current');
 assert.equal(await gradingDue({},tuesdayMorning),true,'over, graded, not yet closed');
 await db.query("INSERT INTO week_notifications(season,week,kind) VALUES(2026,4,'winner')");
 assert.equal(await gradingDue({},tuesdayMorning),false,'already closed');
 assert.deepEqual(await scheduledGrade({},tuesdayMorning),{skipped:'nothing-due'},'an idle tick fetches nothing');
});
test('an ungraded game pick in the current or previous week is due',async()=>{
 await reset();await card(5,[null]);
 assert.equal(await gradingDue({},tuesdayMorning),true);
 await reset();await card(4,['W',null]);
 assert.equal(await gradingDue({},tuesdayMorning),true);
});
test('a week waiting on a manual mark does not re-run every tick',async()=>{
 await reset();await card(4,['W','L','W','W']);
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,game_key,result) VALUES(1,2026,4,'Super Lock',NULL,NULL)");
 assert.equal(await gradingDue({},tuesdayMorning),false);
});
test('a week with no picks has nothing to close',async()=>{
 await reset();
 assert.equal(await gradingDue({},tuesdayMorning),false);
});
