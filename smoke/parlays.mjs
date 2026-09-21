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
const client={document:{addEventListener(){}},state:{}};vm.createContext(client);vm.runInContext(readFileSync(new URL('../public/assets/parlay-parser.js',import.meta.url),'utf8'),client);vm.runInContext(readFileSync(new URL('../public/assets/parlays.js',import.meta.url),'utf8'),client);
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

test('wrapped names, directions, markets and alternate lines stay in their own leg',()=>{
 const rows=client.parseParlayText('Kenneth Walker III\nTOTAL RECEPTIONS\nOver\n3.5\nPatrick Mahomes Rushing Yards\nOver13.5\nEmmett Johnson\n15+\nALT RUSHING YDS\nRashee Rice\n6+ Receptions\nKenneth Walker III\nANY TIME TOUCHDOWN SCORER');
 assert.equal(rows.length,5);assert.deepEqual(Array.from(rows,l=>l.market),['receptions','rush_yds','rush_yds','receptions','anytime_td']);
 assert.deepEqual(Array.from(rows,l=>l.line),[3.5,13.5,15,6,null]);
 assert.equal(rows[2].side,'atleast');assert.ok(rows.every(l=>!l.review.length));
 const split=client.parseParlayText('Patrick Mahomes\nPassing\nYards\nUnder 250.5');assert.equal(split[0].market,'pass_yds');
});
test('missing text is retained without borrowing a different player’s market or inventing a threshold',()=>{
 const parsed=client.parseParlayDocument('3 Leg Parlay\nKenneth Walker III Over 3.5\nPatrick Mahomes Rushing Yards\nOver13.5\nRashee Rice\nTOTAL RECEPTIONS');
 assert.equal(parsed.legs.length,3);assert.equal(parsed.legs[0].market,'');assert.equal(parsed.legs[1].market,'rush_yds');assert.equal(parsed.legs[2].line,null);
 assert.ok(parsed.legs[0].review.length);assert.ok(parsed.legs[2].review.length);
 assert.equal(client.parseParlayDocument('8 Leg Parlay\nRashee Rice 6+ Receptions').warnings.length,1);
 const conflict=client.parseParlayText('RJ Harvey Over 16.5 Rushing Yards\nRJ HARVEY - RECEIVING YARDS')[0];assert.equal(conflict.market,'');assert.ok(conflict.review.length);
});
test('unsupported markets and a lost player heading remain unresolved instead of becoming another bet',()=>{
 const rows=client.parseParlayText('Patrick Mahomes Over 25.5\nLONGEST PASSING COMPLETION\nOver 3.5 Receptions');
 assert.equal(rows.length,2);assert.equal(rows[0].market,'');assert.equal(rows[1].player,'');assert.equal(rows[1].line,3.5);
});

test('broken decimal text is not silently converted to a different numeric bet',()=>{
 for(const text of ['Rashee Rice Over 3 5 Receptions','Rashee Rice Over 3. 5 Receptions']){
  const row=client.parseParlayText(text)[0];assert.equal(row.line,null);assert.ok(row.review.length);
 }
});

test('a repeated player market subtitle completes one selection, including OCR suffix/logo variations',()=>{
 for(const subtitle of ['Kenneth Walker III - Total Receptions','KENNETH WALKER II - TOTAL RECEPTIONS','KENNETH WALKER I1I - TOTAL RECEPTIONS','KENNETH WALKER - TOTAL RECEPTIONS','KENNETH WALKER III-TOTAL RECEPTIONS','KENNETH WALKER III : TOTAL RECEPTIONS','O KENNETH WALKER III - TOTAL RECEPTIONS','KENNETH WALKER III TOTAL RECEPTIONS','KENNETH WALKER III | TOTAL RECEPTIONS']){
  const rows=client.parseParlayText('Kenneth Walker III Over +3.5\n'+subtitle);
  assert.equal(rows.length,1,subtitle);assert.equal(rows[0].market,'receptions',subtitle);assert.equal(rows[0].side,'over');assert.equal(rows[0].line,3.5);assert.equal(rows[0].player,'Kenneth Walker III');
 }
 const typo=client.parseParlayText('Patrick Mahomes Over +13.5\nPATRICK MAHOMESs - RUSHING YDS');assert.equal(typo.length,1);assert.equal(typo[0].market,'rush_yds');assert.ok(typo[0].review.length);
});
test('subtitle matching never collapses different players or separate same-player selections',()=>{
 const rows=client.parseParlayText('Kenneth Walker III Over +3.5\nKENNETH WALKER II - TOTAL RECEPTIONS\nPatrick Mahomes Over +13.5\nPATRICK MAHOMES - RUSHING YDS\nKenneth Walker III Over +45.5\nKENNETH WALKER III - RUSHING YDS');
 assert.equal(rows.length,3);assert.deepEqual(Array.from(rows,l=>l.market),['receptions','rush_yds','rush_yds']);
 const other=client.parseParlayText('Kenneth Walker III Over +3.5\nPATRICK MAHOMES - RUSHING YDS');assert.equal(other.length,2);assert.equal(other[0].market,'');
 assert.equal(client.parlaySubtitleMatch('Josh Allen','Kyle Allen').match,false);
});

test('split repeated subtitles remain one leg, but adjacent same-player props stay separate',()=>{
 const split=client.parseParlayText('Kenneth Walker III Over +3.5\nKENNETH WALKER II\nTOTAL RECEPTIONS');assert.equal(split.length,1);assert.equal(split[0].market,'receptions');
 const typo=client.parseParlayText('Kenneth Walker III Over +3.5\nKENNCTH WALKER III - TOTAL RECEPTIONS');assert.equal(typo.length,1);assert.ok(typo[0].review.length);
 const separate=client.parseParlayText('Kenneth Walker III Over +3.5\nKENNETH WALKER III - TOTAL RECEPTIONS\nKenneth Walker III\nANY TIME TOUCHDOWN SCORER');
 assert.equal(separate.length,2);assert.equal(separate[0].market,'receptions');assert.equal(separate[1].market,'anytime_td');
});

test('leading y-comma OCR noise is removed from titles, subtitles and standalone names',()=>{
 for(const text of ['y, Kenneth Walker III Over +3.5\nKENNETH WALKER III - TOTAL RECEPTIONS','Kenneth Walker III Over +3.5\ny, KENNETH WALKER III - TOTAL RECEPTIONS','y,Kenneth Walker III\nANY TIME TOUCHDOWN SCORER']) {
  const rows=client.parseParlayText(text);assert.equal(rows.length,1);assert.equal(rows[0].player,'Kenneth Walker III');
 }
 assert.equal(client.parlayCleanName('J.K. Dobbins'),'J.K. Dobbins');assert.equal(client.parlayCleanName('A.J. Brown'),'A.J. Brown');
});

test('OCR uses repeated names and word geometry to discard logo text without stripping initials',()=>{
 vm.runInContext(readFileSync(new URL('../public/assets/parlay-ocr.js',import.meta.url),'utf8'),client);
 const word=(text,x0,x1,confidence=95)=>({text,confidence,bbox:{x0,x1,y0:100,y1:130}});
 const title=(name,prefix='vy,')=>({text:prefix+' '+name+' Over +3.5',x:30,right:650,y:115,height:30,confidence:50,words:[word(prefix,30,60,20),...name.split(' ').map((t,i)=>word(t,120+i*100,200+i*100)),word('Over',450,510),word('+3.5',530,610)]});
 const subtitle=name=>({text:name.toUpperCase()+' - TOTAL RECEPTIONS',x:120,right:650,y:160,height:25,confidence:95});
 for(const name of ['Kenneth Walker III','RJ Harvey','J.K. Dobbins']) {
  const filtered=client.parlayFilterLogoText([title(name),subtitle(name)]);
  const legs=client.parseParlayText(client.parlayMergeOcrLines(filtered));
  assert.equal(legs.length,1);assert.equal(legs[0].player,name);assert.equal(legs[0].line,3.5);
 }
 const icon={text:'KC',x:30,right:60,y:115,height:40,confidence:60};
 const clean={...title('Kenneth Walker III'),text:'Kenneth Walker III Over +3.5',x:120,words:title('Kenneth Walker III').words.slice(1)};
 assert.equal(client.parlayFilterLogoText([icon,clean,subtitle('Kenneth Walker III')]).length,2);
 assert.equal(client.parlayFilterLogoText([{...icon,text:'15'},clean,subtitle('Kenneth Walker III')]).length,3);
 assert.equal(client.parlayFilterLogoText([title('Kenneth Walker III')])[0].text,'vy, Kenneth Walker III Over +3.5');
 const real=title('Harvey','RJ');real.words[0]=word('RJ',80,115);real.words[1]=word('Harvey',120,220);
 assert.equal(client.parlayFilterLogoText([real,subtitle('Harvey')])[0].text,'RJ Harvey Over +3.5');
});


test('Hall of Shame requires exactly one settled miss and uses the $5 American-odds profit',()=>{
 const slip={id:'a',season:2026,week:1,night:'Monday',odds:14819,legs:[{result:'W',member_id:1},{result:'L',member_id:2}]};
 const entries=(s=slip,season=2026,night='All')=>client.parlayHallEntries([s],season,night);
 assert.equal(entries()[0].profit,740.95);assert.equal(entries()[0].miss.member_id,2);
 assert.equal(entries({...slip,odds:-120})[0].profit,4.17);
 for(const odds of [null,0,99,'14819',Infinity,NaN])assert.equal(entries({...slip,odds})[0].profit,null);
 for(const results of [['L',null],['L','L'],['W','W'],['L','P'],['L','V'],['L']])assert.equal(entries({...slip,legs:results.map(result=>({result}))}).length,0);
 assert.equal(entries(slip,2025).length,0);assert.equal(entries(slip,2026,'Thursday').length,0);
 assert.equal(entries({...slip,legs:[{result:'W'},{result:'L',member_id:null}]})[0].miss.member_id,null);
 const sorted=client.parlayHallEntries([slip,{...slip,id:'b',odds:20000},{...slip,id:'c',odds:null}],2026);
 assert.equal(sorted[0].slip.id,'b');assert.equal(sorted[2].slip.id,'c');
});

const expanded=`Open Settled Saved
SGP Same Game Parlay +30504 +38132
REWARDS 30 PTS PENDING
PROFIT BOOST 25%
BET PROTECT+
D.J. Moore Over 63.5 D.J. Moore - Receiving Yds, Under 54.5 Total
Points, Sam LaPorta Any Time Touchdown Scorer, Josh Allen Over...
Detroit Lions @ Buffalo Bills 7:15PM CT
D.J. Moore Over 63.5
D. J. MOORE - RECEIVING YDS
Under 54.5
TOTAL POINTS
Sam LaPorta
ANY TIME TOUCHDOWN SCORER
Josh Allen Over 31.5
JOSH ALLEN - RUSHING YDS
D.J. Moore Over 4.5
D.J. MOORE - TOTAL RECEPTIONS
Amon-Ra St. Brown Over 7.5
AMON-RA ST. BROWN - TOTAL RECEPTIONS
Josh Allen
ANY TIME TOUCHDOWN SCORER
Jahmyr Gibbs Over 30.5
JAHMYR GIBBS - RECEIVING YDS
$5.00 $1911.65
TOTAL CHARGED: $5.00
TOTAL PAYOUT
Cash out $1.74
Home My Bets Live Now All Sports`;
test('expanded boosted slip yields eight detailed legs including game total',()=>{
 const doc=client.parseParlayDocument(expanded);
 assert.equal(doc.legs.length,8);
 assert.deepEqual(Array.from(doc.legs,l=>l.market),['rec_yds','game_total','anytime_td','rush_yds','receptions','receptions','anytime_td','rec_yds']);
 assert.deepEqual(Array.from(doc.legs,l=>l.player),['D.J. Moore','Game total','Sam LaPorta','Josh Allen','D.J. Moore','Amon-Ra St. Brown','Josh Allen','Jahmyr Gibbs']);
 assert.deepEqual(Array.from(doc.legs,l=>l.line),[63.5,54.5,null,31.5,4.5,7.5,null,30.5]);
 assert.equal(doc.legs[1].side,'under');assert.equal(doc.odds,38132);
 assert.ok(doc.legs.every(l=>l.review.length===0));
 assert.equal(client.parseParlayDocument(expanded.replace('PROFIT BOOST 25%','')).odds,null);
 assert.equal(client.parseParlayDocument(sample).odds,10087);
 const unclear=client.parseParlayDocument(expanded.replace('+38132','unreadable'));assert.equal(unclear.odds,null);assert.ok(unclear.warnings.some(w=>w.includes('combined odds')));
});
test('game total validation and score-based progress handle final wins, losses, pushes and missing scores',()=>{
 const leg={player:'',market:'game_total',side:'under',line:54.5,member_id:1};
 assert.equal(validateSlip({...body,legs:[leg]},[1]).legs[0].player,'Game total');
 assert.throws(()=>validateSlip({...body,legs:[{...leg,side:'atleast'}]},[1]));
 assert.deepEqual(legProgress(leg,null,false,{state:'in',away_score:21,home_score:24}),{actual:45,result:null});
 assert.equal(legProgress(leg,null,false,{state:'post',away_score:21,home_score:24}).result,'W');
 assert.equal(legProgress(leg,null,false,{state:'post',away_score:28,home_score:27}).result,'L');
 assert.equal(legProgress({...leg,side:'over'},null,false,{state:'post',away_score:28,home_score:27}).result,'W');
 assert.equal(legProgress({...leg,line:54},null,false,{state:'post',away_score:27,home_score:27}).result,'P');
 for(const game of [null,{state:'pre',away_score:0,home_score:0},{state:'post',away_score:null,home_score:27}])assert.equal(legProgress(leg,null,true,game).result,null);
 assert.equal(legProgress({...leg,manual:true,result:'V'},null,true,{state:'post',away_score:27,home_score:27}).result,'V');
});

test('game totals save and settle from final scoreboard even without a player boxscore',async()=>{
 user=1;gameSummary=null;
 const id=crypto.randomUUID();
 const slip={...body,id,legs:[{market:'game_total',side:'under',line:54.5,member_id:2}]};
 assert.equal((await post(slip)).status,200);
 events=[{id:'total-game',away:'Denver Broncos',home:'Kansas City Chiefs',state:'in',away_score:20,home_score:24}];
 const get=async()=>await(await onRequest({env:{},request:new Request('https://app.invalid/api/parlays?season=2026&week=1')})).json();
 let data=await get();assert.equal(data.games[body.game_key].progress[id][0].actual,44);assert.equal(data.slips.find(s=>s.id===id).legs[0].result,null);
 events[0].state='post';events[0].home_score=null;data=await get();assert.equal(data.slips.find(s=>s.id===id).legs[0].result,null);
 events[0].home_score=24;data=await get();assert.equal(data.slips.find(s=>s.id===id).legs[0].result,'W');
 assert.equal(data.slips.find(s=>s.id===id).legs[0].player,'Game total');
});

test('missing player stat cells stay unresolved until a numeric final stat arrives',async()=>{
 user=1;
 const id=crypto.randomUUID();
 const slip={...body,id,legs:[{player:'Emmett Johnson',market:'rush_yds',side:'under',line:15.5,member_id:1}]};
 assert.equal((await post(slip)).status,200);
 events=[{id:'missing-stat-game',away:'Denver Broncos',home:'Kansas City Chiefs',state:'post',away_score:20,home_score:24}];
 const get=async()=>await(await onRequest({env:{},request:new Request('https://app.invalid/api/parlays?season=2026&week=1')})).json();
 for(const value of [null,'','   ',undefined]) {
  gameSummary=summary(0);gameSummary._seedFinal=true;
  gameSummary.boxscore.players[0].statistics[0].athletes[0].stats=[value];
  const data=await get();
  assert.equal(data.slips.find(s=>s.id===id).legs[0].result,null,`missing ${JSON.stringify(value)} must not settle`);
  assert.equal(data.games[body.game_key].progress[id][0].actual,null);
  assert.equal(data.slips.find(s=>s.id===id).version,1);
 }
 // A real zero is meaningful and must still settle (and persist) normally.
 gameSummary=summary(0);gameSummary._seedFinal=true;
 const data=await get();
 assert.equal(data.slips.find(s=>s.id===id).legs[0].result,'W');
 assert.equal(data.slips.find(s=>s.id===id).legs[0].actual,0);
 assert.equal(data.slips.find(s=>s.id===id).version,2);
});

test('real expanded-slip OCR shield fragments preserve standalone touchdown legs',()=>{
 const text='D.J. Moore Over 63.5 ©®\nD.J. MOORE - RECEIVING YDS\nUnder 54.5\nTOTAL POINTS\n2. Sam LaPorta ©®\nANY TIME TOUCHDOWN SCORER\nJosh Allen Over 31.5 ®\nJOSH ALLEN - RUSHING YDS\nD.J. Moore Over 4.5 ©\nD.J. MOORE - TOTAL RECEPTIONS\n~ Amon-Ra St. Brown Over 7.5 ©\nAMON-RA ST. BROWN - TOTAL RECEPTIONS\nJosh Allen ©\nANY TIME TOUCHDOWN SCORER\nJahmyr Gibbs Over 30.5 ®\nJAHMYR GIBBS - RECEIVING YDS';
 const parsed=client.parseParlayDocument(text);
 assert.equal(parsed.legs.length,8);assert.equal(parsed.legs[1].market,'game_total');
 assert.equal(parsed.legs[2].player,'Sam LaPorta');assert.equal(parsed.legs[2].market,'anytime_td');
 assert.equal(parsed.legs[6].player,'Josh Allen');assert.equal(parsed.legs[6].market,'anytime_td');
 assert.ok(parsed.legs.every(l=>!l.review.length));
});

test('low-confidence shields do not erase clear number words, but uncertain numbers remain unresolved',()=>{
 const word=(text,confidence)=>({text,confidence});
 const line={text:'D.J. Moore Over 4.5 ©',confidence:55,words:[word('D.J.',98),word('Moore',98),word('Over',98),word('4.5',98),word('©',5)]};
 assert.equal(client.parlayUncertainThreshold(line),false);
 assert.equal(client.parlayUncertainThreshold({...line,confidence:90,words:[word('Over',99),word('4.5',45)]}),true);
 assert.equal(client.parlayUncertainThreshold({...line,words:[]}),true);
});
