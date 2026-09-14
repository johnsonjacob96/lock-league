import {test,mock,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();let user=1,events=[],gameSummary=null;
function sql(){return (strings,...params)=>db.query(strings.reduce((q,s,i)=>q+(i?'$'+i:'')+s,''),params).then(r=>r.rows);}
mock.module('../functions/_shared/db.js',{namedExports:{sql,ignoringConcurrentCreate:p=>p}});
mock.module('../functions/_shared/auth.js',{namedExports:{verifyCookie:async()=>user,json:(x,init)=>Response.json(x,init)}});
mock.module('../functions/_shared/migrations.js',{namedExports:{ensureExtras:async()=>{}}});
mock.module('../functions/_shared/grader.js',{namedExports:{fetchScoreboard:async()=>events}});
mock.module('../functions/_shared/espn.js',{namedExports:{espnSummary:async()=>gameSummary}});
const {validateSlip,legProgress}=await import('../functions/_shared/parlays.js');
const {onRequest}=await import('../functions/api/parlays.js');
const client={document:{addEventListener(){}},state:{}};vm.createContext(client);vm.runInContext(readFileSync(new URL('../public/assets/parlays.js',import.meta.url),'utf8'),client);
const sample=`Same Game Parlay +10087
Denver Broncos @ Kansas City Chiefs 7:15PM CT
Kenneth Walker III Over +3.5
KENNETH WALKER III - TOTAL RECEPTIONS
Patrick Mahomes Over +13.5
PATRICK MAHOMES - RUSHING YDS
RJ Harvey Over +16.5
RJ HARVEY - RECEIVING YDS
Emmett Johnson 15+ Yards
EMMETT JOHNSON - ALT RUSHING YDS
Rashee Rice 6+ Receptions
RASHEE RICE - ALT RECEPTIONS
Courtland Sutton Over +3.5
COURTLAND SUTTON - TOTAL RECEPTIONS
Kenneth Walker III
ANY TIME TOUCHDOWN SCORER`;
const legs=JSON.parse(JSON.stringify(client.parseParlayText(sample)));
const body={id:crypto.randomUUID(),season:2026,week:1,night:'Monday',title:'Monday night parlay',game_key:'Denver Broncos@Kansas City Chiefs',odds:10087,legs};
before(async()=>{await db.exec('CREATE TABLE members(id INT PRIMARY KEY,name TEXT,is_admin BOOLEAN); INSERT INTO members VALUES(1,\'Uploader\',FALSE),(2,\'Member\',FALSE),(3,\'Admin\',TRUE)');});
after(()=>db.close());
async function post(data,action='save'){const r=await onRequest({env:{},request:new Request('https://app.invalid/api/parlays?action='+action,{method:'POST',body:JSON.stringify(data)})});return {status:r.status,...await r.json()};}
test('example screenshot text yields all seven distinct legs and exact alternate thresholds',()=>{
 assert.equal(legs.length,7);assert.deepEqual(legs.map(l=>l.market),['receptions','rush_yds','rec_yds','rush_yds','receptions','receptions','anytime_td']);
 assert.equal(legs[3].side,'atleast');assert.equal(legs[3].line,15);assert.equal(legs[4].line,6);assert.equal(legs[6].player,'Kenneth Walker III');
 assert.equal(client.parlayMarket('first touchdown scorer'),'manual');
 assert.equal(client.parlayMarket('longest reception yards'),'manual');
});
const summary=value=>({boxscore:{players:[{statistics:[{keys:['rushingYards'],athletes:[{athlete:{displayName:'Emmett Johnson'},stats:[String(value)]}]}]}]}});
test('at-least thresholds differ from over, and live progress never settles a leg',()=>{
 const leg=legs[3];assert.equal(legProgress(leg,summary(15),true).result,'W');assert.equal(legProgress({...leg,side:'over'},summary(15),true).result,'P');
 assert.equal(legProgress(leg,summary(14),true).result,'L');assert.equal(legProgress(leg,summary(16),false).result,null);
 assert.equal(legProgress({...leg,side:'under'},summary(14),true).result,'W');
 assert.equal(legProgress(leg,{boxscore:{}},true).result,null);
 assert.equal(legProgress({...leg,market:'receptions'},summary(15),true).result,null);
 assert.equal(legProgress({...leg,result:'V',manual:true},summary(15),true).result,'V');
});
test('validation rejects forged markets, assignments, odds, thresholds and image data',()=>{
 assert.equal(validateSlip(body,[1,2,3]).legs.length,7);
 for(const bad of [{week:0},{season:2025},{odds:99},{legs:[]},{image:'data:image/svg+xml;base64,bad'},{legs:[{...legs[0],member_id:999}]},{legs:[{...legs[0],line:null}]},{legs:[{...legs[0],market:'evil'}]}])assert.throws(()=>validateSlip({...body,...bad},[1,2,3]));
});
test('authenticated upload, duplicate protection, edit authorization, CAS, assignment and manual grading',async()=>{
 user=null;assert.equal((await post(body)).status,401);user=1;
 assert.equal((await post(body)).status,200);
 assert.equal((await post(body)).status,409);
 user=2;assert.equal((await post({...body,version:1})).status,403);user=1;
 assert.equal((await post({id:body.id,version:1,index:0,result:'W'},'grade')).status,200);
 assert.equal((await post({...body,version:1})).status,409);
 const saved=(await db.query('SELECT * FROM parlay_slips WHERE id=$1',[body.id])).rows[0];
 saved.legs[0].member_id=2;
 assert.equal((await post(saved)).status,200);
 let current=(await db.query('SELECT * FROM parlay_slips WHERE id=$1',[body.id])).rows[0];
 assert.equal(current.legs[0].result,'W');assert.equal(current.legs[0].member_id,2);
 current.legs[0].line=4.5;
 assert.equal((await post(current)).status,200);
 current=(await db.query('SELECT * FROM parlay_slips WHERE id=$1',[body.id])).rows[0];assert.equal(current.legs[0].result,null);
 user=3;assert.equal((await post({id:body.id,version:current.version,index:1,result:'V'},'grade')).status,200);
});
test('leaderboard uses individual assigned legs, excludes push/void and supports night filters',()=>{
 const slips=[{night:'Monday',legs:[{member_id:1,result:'W'},{member_id:1,result:'P'},{member_id:1,result:'V'},{member_id:null,result:'W'},{member_id:2,result:'L'}]},{night:'Thursday',legs:[{member_id:1,result:'L'}]}];
 const members=[{id:1,name:'One'},{id:2,name:'Two'}];
 const all=client.parlayRecord(slips,members);assert.equal(all[0].pct,.5);assert.equal(all[0].W,1);assert.equal(all[0].P,1);assert.equal(all[0].V,1);
 assert.equal(client.parlayRecord(slips,members,'Monday')[0].pct,1);
});

test('live API updates progress, waits for a final summary, then persists exact-threshold wins',async()=>{
 user=1;
 const id=crypto.randomUUID(),sample={...body,id,legs:[{player:'Emmett Johnson',market:'rush_yds',side:'atleast',line:15,member_id:1}]};
 assert.equal((await post(sample)).status,200);
 events=[{id:'fixture-game',away:'Denver Broncos',home:'Kansas City Chiefs',state:'in',home_score:7,away_score:0}];gameSummary=summary(15);
 const get=async()=>await(await onRequest({env:{},request:new Request('https://app.invalid/api/parlays?season=2026&week=1')})).json();
 let data=await get();assert.equal(data.games[body.game_key].progress[id][0].actual,15);assert.equal(data.slips.find(s=>s.id===id).legs[0].result,null);
 events[0].state='post';data=await get();assert.equal(data.slips.find(s=>s.id===id).legs[0].result,null);
 gameSummary._seedFinal=true;data=await get();assert.equal(data.slips.find(s=>s.id===id).legs[0].result,'W');
 assert.equal(data.slips.find(s=>s.id===id).image,undefined);
 gameSummary=null;data=await get();assert.equal(data.slips.find(s=>s.id===id).legs[0].result,'W');
});
