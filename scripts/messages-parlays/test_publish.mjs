import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, nightForDate } from './publish.mjs';

function fixture() {
  const context = {target_date:'2026-10-08', images:[
    {attachment_id:1,time:'2026-10-08T19:00:00-05:00'},
    {attachment_id:2,time:'2026-10-08T19:05:00-05:00'}],
    games:[{game_key:'Tampa Bay Buccaneers@Dallas Cowboys',season:2026,week:5}],
    members:[{id:1,name:'A'},{id:2,name:'B'},{id:3,name:'Jack'}],
    messages:[{id:10,member:'A',text:'Receiver six catches'}, {id:11,member:'B',text:'under game total'}],
    allowed_markets:['receptions','game_total']};
  const extraction={status:'ready',all_legs_visible:true,receipt_attachment_id:1,
    game_key:context.games[0].game_key,odds:45000,displayed_leg_count:2,
    images:[{attachment_id:1,kind:'placed_receipt'},{attachment_id:2,kind:'placed_receipt'}],
    legs:[{player:'Receiver Name',market:'receptions',side:'atleast',line:6,member:'A',evidence_ids:[10]},
      {player:'Game total',market:'game_total',side:'under',line:48.5,member:'B',evidence_ids:[11]}]};
  return {context,extraction};
}
const build = f => prepare(f.extraction,f.context,'data:image/jpeg;base64,/9j/AAAA','test-chat');
test('first receipt preserves boost, inclusive threshold, assignment and absent Jack',()=>{
  const body=build(fixture());
  assert.equal(body.odds,45000);assert.equal(body.legs[0].side,'atleast');
  assert.equal(body.legs[0].line,6);assert.deepEqual(body.legs.map(l=>l.member_id),[1,2]);
  assert.equal(body.legs[1].market,'game_total');
});
test('same receipt yields same UUID for retry idempotency',()=>assert.equal(build(fixture()).id,build(fixture()).id));
const reject = (name,mutate) => test(name,()=>{const f=fixture();mutate(f);assert.throws(()=>build(f));});
reject('cannot choose later receipt',f=>f.extraction.receipt_attachment_id=2);
reject('unreadable earlier attachment blocks later receipt',f=>{
  f.extraction.images[0].kind='unreadable';f.extraction.receipt_attachment_id=2;
});
reject('all images must be classified',f=>f.extraction.images.pop());
reject('cannot assign another authors suggestion',f=>f.extraction.legs[0].evidence_ids=[11]);
reject('cannot invent evidence',f=>f.extraction.legs[0].evidence_ids=[999]);
reject('cannot silently omit cropped legs',f=>f.extraction.all_legs_visible=false);
reject('leg count must agree',f=>f.extraction.displayed_leg_count=3);
reject('only scheduled game accepted',f=>f.extraction.game_key='Other@Game');
reject('receipt date must match',f=>f.context.images[0].time='2026-10-09T00:00:00-05:00');
reject('duplicate owners require review',f=>f.extraction.legs[1].member='A');
test('builder is skipped in favor of first actually placed receipt',()=>{
  const f=fixture();f.extraction.images[0].kind='builder';f.extraction.receipt_attachment_id=2;
  assert.ok(build(f));
});
test('only Monday and Thursday dates accepted',()=>{
  assert.equal(nightForDate('2026-10-12'),'Monday');
  assert.equal(nightForDate('2026-10-08'),'Thursday');
  assert.throws(()=>nightForDate('2026-10-13'));
});
