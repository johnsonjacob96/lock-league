import {test} from 'node:test';
import assert from 'node:assert/strict';
import {missingPlayerStats} from '../functions/_shared/espn-player-stats.js';
import {gradeProp,PROP_DEFS} from '../functions/_shared/props.js';
import {resolvePickResult} from '../functions/_shared/grader.js';
const box={players:[{team:{id:'12'},statistics:[]},{team:{id:'13'},statistics:[]}]};
const prop={market:'anytime_td',player:'Rashee Rice',side:'yes',line:null};
const zeros=Object.fromEntries(PROP_DEFS.anytime_td.stat.map(k=>[k,0]));
function mockFeed(t,{dnp=false,missing=false,wrong=false,duplicate=false,stats=zeros}={}){
 let calls=0;
 t.mock.method(globalThis,'fetch',async url=>{
  calls++;const path=new URL(url).pathname;
  let data;
  if(path.endsWith('/roster')) data={entries:(!path.includes('/13/')||duplicate)?[{displayName:'Rice',playerId:4428331,didNotPlay:dnp}]:[]};
  else if(path.includes('/athletes/'))data={id:4428331,displayName:wrong?'Ray Rice':'Rashee Rice'};
  else data={splits:{name:'game',categories:[{stats:Object.entries(stats).map(([name,value])=>({name,value}))}]}};
  return new Response(JSON.stringify(data),{status:missing?503:200});
 });return ()=>calls;
}
test('participant omitted from box score resolves using explicit final game zeros',async t=>{
 const calls=mockFeed(t);
 const stats=await missingPlayerStats('401872976','Rashee Rice',box);
 assert.deepEqual(stats,zeros);assert.equal(calls(),4);assert.equal(gradeProp(prop,box,stats),'L');
 assert.equal(gradeProp({...prop,market:'receptions',side:'over',line:3.5},box,{receptions:0}),'L');
 assert.equal(gradeProp({...prop,market:'receptions',side:'under',line:3.5},box,{receptions:0}),'W');
 assert.equal(gradeProp({...prop,market:'receptions',side:'over',line:0},box,{receptions:0}),'P');
});
for(const [name,opts] of [['DNP',{dnp:true}],['provider failure',{missing:true}],['wrong identity',{wrong:true}],['ambiguous identity',{duplicate:true}]]) test(`${name} stays unresolved`,async t=>{mockFeed(t,opts);assert.equal(await missingPlayerStats('401872976','Rashee Rice',box),null);});
test('missing fallback fields never become zero',()=>{
 assert.equal(gradeProp(prop,box,{}),null);
 assert.equal(gradeProp(prop,box,{...zeros,receivingTouchdowns:undefined}),null);
 assert.equal(gradeProp(prop,box,{...zeros,receivingTouchdowns:1}),'W');
});
test('fallback is used only for a final game with a valid boxscore and missing player',async()=>{
 const pick={bet_type:'Super Lock',prop_meta:prop};let calls=0;
 const fallback=async()=>{calls++;return zeros;};
 assert.equal(await resolvePickResult(pick,{id:'1',state:'in'},async()=>box,fallback),null);
 assert.equal(await resolvePickResult(pick,{id:'1',state:'post'},async()=>null,fallback),null);
 assert.equal(calls,0);
 assert.equal(await resolvePickResult(pick,{id:'1',state:'post'},async()=>box,fallback),'L');assert.equal(calls,1);
});
