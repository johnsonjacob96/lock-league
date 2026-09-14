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
test('pending or unlocked weeks never crown; partial rankings ignore SL tiebreaks',()=>{
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
