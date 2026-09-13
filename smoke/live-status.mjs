import {test} from 'node:test';
import assert from 'node:assert/strict';
import {livePickStatus} from '../functions/api/warroom.js';
const game={state:'in',home:'Seattle Seahawks',away:'New England Patriots',home_score:7,away_score:0,detail:'Q1 · 8:00'};
test('unfinished spreads and totals stay pending regardless of score',()=>{
 for(const state of ['pre','in']) for(const total of [0,7,50]) {
  for(const pick of [
   {bet_type:'Favorite',side:'home',line:-3.5},
   {bet_type:'Dog',side:'away',line:3.5},
   {bet_type:'Over',side:'over',line:44.5},
   {bet_type:'Under',side:'under',line:44.5},
   {bet_type:'Super Lock',prop_meta:{kind:'total'},side:'over',line:44.5},
   {bet_type:'Super Lock',prop_meta:{market:'passing_yards'},line:200.5},
  ]) {
   const status=livePickStatus(pick,{...game,state,home_score:total});
   assert.equal(status.status,'pending');assert.equal(status.state,state);assert.equal(!!status.final,false);
  }
 }
});
test('final results still resolve wins, losses and pushes; ungraded props stay manual',()=>{
 const final={...game,state:'post',home_score:27,away_score:17};
 for(const [side,line,expected] of [['over',43.5,'win'],['under',43.5,'lose'],['over',44,'push']]) {
  const status=livePickStatus({bet_type:side==='over'?'Over':'Under',side,line},final);
  assert.equal(status.status,expected);assert.equal(status.final,true);
 }
 assert.equal(livePickStatus({bet_type:'Super Lock',prop_meta:{market:'passing_yards'}},final).status,'manual');
});
