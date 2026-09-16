import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
let removed=[],rows=[],status={};
mock.module('../functions/_shared/db.js',{namedExports:{ignoringConcurrentCreate:p=>p,sql:()=>async(strings,...args)=>{const q=strings.join('?');if(q.includes('DELETE'))removed.push(args[0]);return q.includes('SELECT')?rows:[];}}});
mock.module('../functions/_shared/migrations.js',{namedExports:{ensureExtras:async()=>{}}});
mock.module('../functions/_shared/webpush.js',{namedExports:{sendPush:async sub=>{if(status[sub.endpoint]===0)throw Error('network');return {ok:status[sub.endpoint]===201,status:status[sub.endpoint]};}}});
const {pushPersonalized}=await import('../functions/_shared/push-notify.js');
test('delivery reports accepted members, keeps retryable failures and prunes expired devices',async()=>{
 rows=[{member_id:1,endpoint:'apple-ok'},{member_id:1,endpoint:'desktop-error'},{member_id:2,endpoint:'expired'},{member_id:3,endpoint:'network'},{member_id:4,endpoint:'off',notif_prefs:{lineMoves:false}}];
 status={'apple-ok':201,'desktop-error':503,expired:410,network:0};
 const r=await pushPersonalized({},Object.fromEntries([1,2,3,4].map(id=>[id,{body:'fixture'}])),'lineMoves');
 assert.equal(r.sent,1);assert.equal(r.failed,3);assert.equal(r.pruned,1);assert.deepEqual(r.acceptedMemberIds,[1]);assert.deepEqual(removed,[['expired']]);
});
