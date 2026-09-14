import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {oddsProfit,rankEntries,weeklyDecision,weeklyEntries,seasonMetrics,SEASON_CRITERIA} from '../functions/_shared/tiebreaks.js';
import {weeklyContext} from '../functions/_shared/tiebreak-context.js';
const entry=(id,extra={})=>({id,name:id,W:3,L:2,P:0,pending:0,superHit:1,superOdds:1.5,seasonPct:.6,allTimePct:.55,...extra});
const win=(a,b)=>weeklyDecision([entry('A',a),entry('B',b)]).winner?.id;
test('weekly rule precedence: record, SL hit, odds, season %, all-time %',()=>{
 assert.equal(win({W:4,superHit:0},{superOdds:5}),'A');
 assert.equal(win({L:1,superHit:0},{superOdds:5}),'A');
 assert.equal(win({superHit:1,superOdds:1},{superHit:0,superOdds:5}),'A');
 assert.equal(win({superOdds:2,seasonPct:.4},{superOdds:1.5,seasonPct:.9}),'A');
 assert.equal(win({seasonPct:.7,allTimePct:.4},{seasonPct:.6,allTimePct:.9}),'A');
 assert.equal(win({allTimePct:.7},{allTimePct:.6}),'A');
 assert.equal(win({},{}),undefined);
 assert.equal(win({W:0,L:5,superHit:0,superOdds:2},{W:0,L:5,superHit:0,superOdds:1}),'A');
});
test('odds compare equivalent $1 risks, including minus odds and even money',()=>{
 assert.equal(oddsProfit(150),1.5);assert.equal(oddsProfit(-120),100/120);
 assert.equal(oddsProfit(-100),oddsProfit(100));
 for(const p of [null,undefined,'',0,99,-99,Infinity,'bad'])assert.equal(oddsProfit(p),null);
 assert.equal(win({superOdds:oddsProfit(-110)},{superOdds:oddsProfit(-120)}),'A');
});
test('unknown odds stop resolution; later stats cannot override the missing criterion',()=>{
 assert.equal(win({superOdds:null,seasonPct:.9},{superOdds:1.5,seasonPct:.1}),undefined);
 assert.equal(win({superHit:1,superOdds:null},{superHit:0,superOdds:1.5}),'A');
 const ranked=rankEntries([entry('C',{superOdds:3}),entry('B',{superOdds:null}),entry('A',{superOdds:1})]);
 assert.deepEqual(ranked.map(r=>r.rank),[1,1,1]);
});
test('catchable or unlocked weeks never crown; partial rankings ignore SL tiebreaks',()=>{
 const entries=[entry('A',{superOdds:5}),entry('B',{pending:1})];
 assert.equal(weeklyDecision(entries).winner,null);
 assert.deepEqual(weeklyDecision(entries).ranked.map(r=>r.rank),[1,1]);
 assert.equal(weeklyDecision([entry('A',{W:5}),entry('B')],false).winner,null);
 assert.equal(win({W:0,L:5},{W:0,L:5}),undefined);
});
test('multiway groups refine in order and preserve competition ranks',()=>{
 const rows=rankEntries([entry('C',{superHit:0}),entry('B',{superOdds:1}),entry('A',{superOdds:2}),entry('D',{W:2})]);
 assert.deepEqual(rows.map(r=>[r.id,r.rank]),[['A',1],['B',2],['C',3],['D',4]]);
});
test('season rules use SL record then total odds then winning odds, never weekly wins',()=>{
 const e=(id,extra={})=>({id,W:30,L:20,superW:5,superL:5,totalOdds:15,winningOdds:8,...extra});
 const first=(a,b)=>rankEntries([e('A',a),e('B',b)],SEASON_CRITERIA)[0];
 assert.equal(first({superW:6,totalOdds:1},{totalOdds:100}).id,'A');
 assert.equal(first({superL:4,totalOdds:1},{totalOdds:100}).id,'A');
 assert.equal(first({totalOdds:20,winningOdds:5},{totalOdds:15,winningOdds:10}).id,'A');
 assert.equal(first({winningOdds:10},{winningOdds:8}).id,'A');
 assert.equal(first({totalOdds:null},{winningOdds:20}).tied,true);
});
test('season sums include priced wins losses pushes; exclude unfinished and missing-slot odds',()=>{
 const rows=[{result:'W',price:150},{result:'L',price:-120},{result:'P',price:200},{result:null,price:999},{result:'L',missing:true}].map(p=>({...p,bet_type:'Super Lock'}));
 const m=seasonMetrics(rows);assert.equal(m.totalOdds,1.5+100/120+2);assert.equal(m.winningOdds,1.5);assert.equal(m.superL,2);
 assert.equal(seasonMetrics([...rows,{result:'L',bet_type:'Super Lock'}]).totalOdds,null);
});
test('percentages exclude pushes and use provided prior history',()=>{
 const p=(member_id,result)=>({member_id,bet_type:'Super Lock',result,price:150});
 const rows=[p('A','W'),p('B','W')];
 const entries=weeklyEntries(['A','B'],rows,{locked:true,seasonPicks:[...rows,{member_id:'A',result:'P'}],historical:{A:{W:9,L:10},B:{W:1,L:10}}});
 assert.equal(entries[0].seasonPct,1);assert.equal(entries[0].allTimePct,.5);
 assert.equal(weeklyDecision(entries).winner.id,'A');
});
test('weekly context excludes later weeks, counts missing slots, and does not mutate picks',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T00:00Z')});
 const members=[{id:1,name:'Fixture A'},{id:2,name:'Fixture B'}];
 const rows=[{member_id:1,week:1,bet_type:'Super Lock',result:'W',price:150},{member_id:2,week:1,bet_type:'Super Lock',result:'W',price:100}];
 const before=JSON.stringify(rows);const one=weeklyContext(rows,members,2026,1,{});
 assert.equal(one.winner.id,1);assert.equal(one.winner.L,4);
 const later=weeklyContext([...rows,{member_id:2,week:2,bet_type:'Super Lock',result:'W',price:900}],members,2026,1,{});
 assert.deepEqual(later,one);assert.equal(JSON.stringify(rows),before);
});
test('browser generated rules match server exactly',()=>{
 const context={};vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/assets/tiebreaks.js',import.meta.url),'utf8')+'\nthis.rules=LeagueTiebreaks;',context);
 for(const rows of [[entry('A'),entry('B',{superOdds:3})],[entry('A',{superOdds:null}),entry('B')]])
  assert.equal(JSON.stringify(context.rules.weeklyDecision(rows)),JSON.stringify(weeklyDecision(rows)));
});

test('Week 1 clinch: Mason beats Chris on SL hit and Brayden even if his -120 SL wins',()=>{
 const types=['Favorite','Dog','Over','Under','Super Lock'];
 const card=(id,results,price)=>types.map((bet_type,i)=>({member_id:id,bet_type,result:results[i],price}));
 const picks=[...card('Mason',['W','W','W','L','W'],-113),...card('Chris',['W','W','W','W','L'],190),...card('Brayden',['W','W','W','L',null],-120)];
 const decide=rows=>weeklyDecision(weeklyEntries(['Mason','Chris','Brayden'],rows,{locked:true}));
 const d=decide(picks);
 assert.equal(d.winner.id,'Mason');assert.equal(d.clinched,true);assert.equal(d.complete,false);
 assert.equal(d.winner.W,4);assert.equal(d.ranked.find(e=>e.id==='Brayden').pending,1);
 assert.equal(d.winner.tiebreak,'Longer Super Lock odds');
 for (const result of ['W','L','P']) {
   const final=decide(picks.map(p=>p.result ? p : {...p,result}));
   assert.equal(final.winner.id,'Mason');assert.equal(final.complete,true);assert.equal(final.clinched,false);
 }
 for (const price of [150,null]) {
   const stillOpen=decide(picks.map(p=>p.member_id==='Brayden'?{...p,price}:p));
   assert.equal(stillOpen.winner,null);
 }
});
test('clinch bounds handle open leader picks, pushes, ties, unknown odds and unlocked cards',()=>{
 const leader=entry('A',{W:4,L:0,pending:1,superHit:1,superPending:false});
 const rival=entry('B',{W:2,L:2,pending:1,superHit:0,superPending:true});
 assert.equal(weeklyDecision([leader,rival]).winner.id,'A');
 assert.equal(weeklyDecision([leader,rival],false).winner,null);
 assert.equal(weeklyDecision([leader,{...rival,W:3,L:1,superOdds:3}]).winner,null);
 assert.equal(weeklyDecision([leader,{...rival,W:3,L:1,superOdds:1.5}]).winner,null);
 assert.equal(weeklyDecision([leader,{...rival,W:3,L:1,superOdds:null}]).winner,null);
 assert.equal(weeklyDecision([]).winner,null);
});
test('every announced clinch survives exhaustive independent W/L/push completions',()=>{
 const types=['Favorite','Dog','Over','Under','Super Lock'];
 const ids=['A','B','C'];
 let clinches=0;
 for(let fixture=0;fixture<125;fixture++) {
   const rows=ids.flatMap((member_id,m)=>types.map((bet_type,i)=>({member_id,bet_type,
     result:(i===4 && m>0) || (m===0 && i===3) ? null : i===4 ? 'W' : i < Math.floor(fixture/5**m)%5 ? 'W':'L',price:[150,-120,-113][m]})));
   const entries=weeklyEntries(ids,rows,{locked:true});
   const d=weeklyDecision(entries);
   if(!d.winner)continue;
   clinches++;
   const unfinished=rows.flatMap((p,i)=>p.result?[]:[i]);
   for(let mask=0;mask<3**unfinished.length;mask++) {
     let n=mask;const completed=rows.map(p=>({...p}));
     for(const i of unfinished){completed[i].result=['W','L','P'][n%3];n=Math.floor(n/3);}
     assert.equal(weeklyDecision(weeklyEntries(ids,completed,{locked:true})).winner?.id,d.winner.id);
   }
 }
 assert.ok(clinches>0,'exercise actual early winners');
});

test('clinch uses future percentage bounds and stops at an unresolved percentage tie',()=>{
 const types=['Favorite','Dog','Over','Under','Super Lock'];
 const week=types.flatMap((bet_type,i)=>[
   {member_id:'A',bet_type,result:['W','W','W','L','W'][i],price:150},
   {member_id:'B',bet_type,result:[null,'W','W','L','W'][i],price:150},
 ]);
 const entries=prior=>weeklyEntries(['A','B'],week,{locked:true,seasonPicks:[...week,...prior],historical:{A:{W:0,L:0},B:{W:0,L:0}}});
 assert.equal(weeklyDecision(entries([])).winner,null);
 assert.equal(weeklyDecision(entries([{member_id:'A',result:'W'}])).winner.id,'A');
 // A pending prior result could erase that advantage; don't use the current %.
 assert.equal(weeklyDecision(entries([{member_id:'A',result:'W'},{member_id:'A',result:null}])).winner,null);
});
