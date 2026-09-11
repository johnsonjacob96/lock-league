// Real PostgreSQL semantics in an isolated in-memory database. Only the transport
// and providers are replaced; the production handlers and SQL execute unchanged.
import { test, mock, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
let statements = [], beforeWrite = null;
function sql() {
  const tag = (strings, ...params) => {
    const query = strings.reduce((q, part, i) => q + (i ? `$${i}` : '') + part, '');
    return { query, params, then(resolve, reject) { return db.query(query, params).then(r => r.rows).then(resolve, reject); } };
  };
  tag.transaction = async queries => {
    if (beforeWrite) { const fn = beforeWrite; beforeWrite = null; await fn(); }
    statements.push(...queries.map(q => q.query));
    return db.transaction(async tx => {
      const results = [];
      for (const q of queries) results.push((await tx.query(q.query, q.params)).rows);
      return results;
    });
  };
  return tag;
}
mock.module('../functions/_shared/db.js', { namedExports: { sql, ignoringConcurrentCreate: p => p } });
const events = [
 { away: 'New England Patriots', home: 'Seattle Seahawks', kickoff: '2026-09-10T00:20:00Z' },
 { away: 'Dallas Cowboys', home: 'New York Giants', kickoff: '2026-09-13T17:00:00Z' },
 { away: 'Kansas City Chiefs', home: 'Denver Broncos', kickoff: '2026-09-15T00:20:00Z' },
];
let board = events;
mock.module('../functions/_shared/grader.js', { namedExports: {
 fetchScoreboard: async () => board,
 sameTeam: (a,b) => !!a && !!b && a.toLowerCase() === b.toLowerCase(),
}});
let pushSubs = 0, pushed = [];
mock.module('../functions/_shared/push-notify.js', { namedExports: {
 ensurePushTables: async () => {},
 pushToMembers: async (env, ids, payload) => { pushed.push({ ids, payload }); return { sent: pushSubs, failed: 0, pruned: 0 }; },
 pushPersonalized: async () => ({ sent: 0, failed: 0, pruned: 0 }),
 claimSend: async () => true,
}});
const { onRequest: picks } = await import('../functions/api/picks.js');
const { onRequest: auth } = await import('../functions/api/auth.js');
const { sign } = await import('../functions/_shared/auth.js');
const { computeWeeklyWinners } = await import('../functions/api/settlement.js');
const { weeklyMemberRecords, weeklyWinner } = await import('../functions/_shared/standings.js');
const { pickCutoff, currentNflWeek, weeksToGrade, SEASON_2026_KICKOFF } = await import('../functions/_shared/nfl.js');
const bcrypt = (await import('bcryptjs')).default;
const env = { SESSION_SECRET: 'test-only-session-secret' };
let cookie, oddsDown = false, propsDown = false;
let fetchCalls = 0, oddsCalls = 0, oddsFailAfter = Infinity;
const liveGames = events.map(e => ({ ...e, books: { fanduel: { spread: { fav: e.home, line: -3.5, favPrice: -110, dogPrice: -110 }, total: { point: 44.5, overPrice: -110, underPrice: -110 } } } }));
const fixtureFetch = async url => {
 fetchCalls++;
 const props = String(url).includes('/api/props');
 if (!props && oddsCalls++ >= oddsFailAfter) throw new Error('provider unavailable');
 if (props ? propsDown : oddsDown) throw new Error('provider unavailable');
 for(const g of liveGames)for(const b of Object.values(g.books))b.updated=new Date().toISOString();
 return Response.json(props ? {markets:[{ market:'receptions', kind:'ou', players:[{player:'Test Receiver',line:3.5,fanduel:{line:3.5,over:110,under:-110,updated:new Date().toISOString()},alts:[]}]}]} : { source: 'sharpapi', games: liveGames });
};
const key = i => `${events[i].away}@${events[i].home}`;
const pick = (bet_type='Favorite', i=1) => ({ bet_type, game_key:key(i), side:({Favorite:'fav',Dog:'dog',Over:'over',Under:'under'})[bet_type], line:999, price:999, pick_text:'fabricated' });
async function request(body, action='', signed=true, method='POST') {
 const r = await picks({env,request:new Request(`https://test.invalid/api/picks${action ? '?'+action : ''}`,{method,headers:signed?{cookie}: {},...(method==='POST'?{body:JSON.stringify(body)}:{})})});
 return {status:r.status,body:await r.json()};
}
// Cookies are epoch-stamped once ensureExtras has run; before that they carry
// the pre-epoch payload, which is exactly what a cookie issued before this
// feature shipped looks like.
async function cookieFor(id) {
 const epoch = await db.query('SELECT session_epoch FROM members WHERE id=$1',[id]).then(r=>r.rows[0].session_epoch).catch(()=>null);
 return `ll_session=${await sign(env, epoch==null?String(id):`${id}.${epoch}`)}`;
}
async function insertOld({result=null, i=0, bet='Favorite'}={}) {
 await db.query('INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,result,locked_at) VALUES(1,2026,1,$1,$2,$3,$4,$5)',[bet,'old',key(i),result,'2026-09-09T12:00:00Z']);
}
before(async()=>{
 await db.exec(`CREATE TABLE members(id serial PRIMARY KEY,name text,passphrase_h text);
 CREATE TABLE push_subscriptions(id serial PRIMARY KEY,member_id int,endpoint text,p256dh text,auth text);
 CREATE TABLE picks(id serial PRIMARY KEY,member_id int,season int,week int,bet_type text,pick_text text,game_key text,side text,line numeric,book text,price int,result text,graded_at timestamptz,locked_at timestamptz, UNIQUE(member_id,season,week,bet_type));`);
 await db.query('INSERT INTO members(id,name,passphrase_h) VALUES(1,$1,$2),(2,$3,$2)',['Jacob',await bcrypt.hash('test-password',4),'Jared']);
});
beforeEach(async()=>{
 mock.method(globalThis, "fetch", fixtureFetch);
 mock.timers.reset(); mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-11T12:00:00Z')});
 cookie=await cookieFor(1);
 await db.exec('DELETE FROM picks'); oddsDown=false; propsDown=false; board=events; fetchCalls=0; oddsCalls=0; oddsFailAfter=Infinity; beforeWrite=null; statements=[];
 await db.exec('DROP TABLE IF EXISTS odds_snapshot');
 pushSubs = 0; pushed = [];
 await db.exec('DELETE FROM password_resets').catch(()=>{});
 await db.exec('DELETE FROM push_subscriptions');
 await db.query('UPDATE members SET is_admin = FALSE').catch(()=>{});
});
after(async()=>{mock.timers.reset();await db.close();});

test('login, me, wrong password, logout and signed-cookie flags',async()=>{
 const call=async(action,body,headers={})=>auth({env,request:new Request(`https://test.invalid/api/auth?action=${action}`,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})})});
 assert.equal((await call('login',{name:'Jacob',passphrase:'wrong'})).status,401);
 const login=await call('login',{name:'Jacob',passphrase:'test-password'}); assert.equal(login.status,200);
 assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Secure/);
 assert.equal((await (await call('me',null,{cookie:login.headers.get('set-cookie')})).json()).member.id,1);
 assert.match((await call('logout',{})).headers.get('set-cookie'),/Max-Age=0/);
});
// ---- Password recovery ----
const authCall = (action, body, headers = {}) => auth({ env: authEnv, request: new Request(`https://test.invalid/api/auth?action=${action}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }) });
const authEnv = { ...env, CRON_SECRET: 'test-cron-secret' };
const codeFrom = r => r.code;

test('push reset: code goes to the member devices and signs them back in',async()=>{
 pushSubs = 1;
 await db.query("INSERT INTO push_subscriptions(member_id,endpoint,p256dh,auth) VALUES(1,'e','p','a')");
 const req = await (await authCall('reset-request',{name:'Jacob'})).json();
 assert.equal(req.channel,'push');
 assert.equal(pushed.length,1);
 const code = pushed[0].payload.body.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];
 // The code is only ever stored hashed.
 const stored = (await db.query('SELECT code_h FROM password_resets')).rows[0].code_h;
 assert.ok(!stored.includes(code.replace('-','')));
 const done = await authCall('reset-confirm',{name:'Jacob',code:code.toLowerCase(),next:'brand-new-password'});
 assert.equal(done.status,200);
 assert.match(done.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Secure/);
 assert.equal((await (await authCall('login',{name:'Jacob',passphrase:'brand-new-password'})).json()).member.id,1);
 await db.query('UPDATE members SET passphrase_h=$1 WHERE id=1',[await bcrypt.hash('test-password',4)]);
});

test('a reset revokes the sessions the old password left signed in',async()=>{
 pushSubs = 1;
 const before = await cookieFor(1);
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie:before}})})).json()).member.id,1);
 const issued = codeFrom(await (await authCall('reset-issue',{name:'Jacob'},{'X-Cron-Secret':'test-cron-secret'})).json());
 const done = await authCall('reset-confirm',{name:'Jacob',code:issued,next:'another-password'});
 const after = done.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie:before}})})).json()).member,null);
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie:after}})})).json()).member.id,1);
 await db.query('UPDATE members SET passphrase_h=$1 WHERE id=1',[await bcrypt.hash('test-password',4)]);
});

test('reset codes are single use, expiring, attempt-capped and member-scoped',async()=>{
 const code = codeFrom(await (await authCall('reset-issue',{name:'Jared'},{'X-Cron-Secret':'test-cron-secret'})).json());
 // Wrong code burns an attempt; five wrong tries lock the code out.
 for (let i=0;i<5;i++) assert.equal((await authCall('reset-confirm',{name:'Jared',code:'AAAA-AAAA',next:'password-x'})).status,401);
 assert.equal((await authCall('reset-confirm',{name:'Jared',code,next:'password-x'})).status,429);
 // A fresh code works once, then is spent.
 const good = codeFrom(await (await authCall('reset-issue',{name:'Jared'},{'X-Cron-Secret':'test-cron-secret'})).json());
 assert.equal((await authCall('reset-confirm',{name:'Jared',code:good,next:'password-x'})).status,200);
 assert.equal((await (await authCall('reset-confirm',{name:'Jared',code:good,next:'password-y'})).json()).error,'no-code');
 // Expired codes do not redeem.
 const stale = codeFrom(await (await authCall('reset-issue',{name:'Jared'},{'X-Cron-Secret':'test-cron-secret'})).json());
 await db.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 minute' WHERE used_at IS NULL");
 assert.equal((await (await authCall('reset-confirm',{name:'Jared',code:stale,next:'password-z'})).json()).error,'no-code');
});

test('only a commissioner or the cron secret can issue a code for someone else',async()=>{
 assert.equal((await authCall('reset-issue',{name:'Jared'})).status,401);
 assert.equal((await authCall('reset-issue',{name:'Jared'},{cookie})).status,403);
 assert.equal((await authCall('set-admin',{name:'Jacob'})).status,403);
 assert.equal((await authCall('set-admin',{name:'Jacob'},{'X-Cron-Secret':'test-cron-secret'})).status,200);
 assert.equal((await authCall('reset-issue',{name:'Jared'},{cookie})).status,200);
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie}})})).json()).member.is_admin,true);
});

test('a member with no registered device is told to ask the commissioner',async()=>{
 pushSubs = 0;
 const r = await (await authCall('reset-request',{name:'Jared'})).json();
 assert.equal(r.channel,'none');
 assert.equal((await db.query('SELECT COUNT(*)::int n FROM password_resets')).rows[0].n,0);
 assert.equal((await authCall('reset-request',{name:'Nobody'})).status,404);
});

test('repeat code requests are rate limited',async()=>{
 pushSubs = 1;
 await db.query("INSERT INTO push_subscriptions(member_id,endpoint,p256dh,auth) VALUES(2,'e2','p','a')");
 assert.equal((await authCall('reset-request',{name:'Jared'})).status,200);
 assert.equal((await authCall('reset-request',{name:'Jared'})).status,429);
});

test('a password change signs the other devices out',async()=>{
 const old = cookie;
 const r = await authCall('change-pass',{current:'test-password',next:'changed-password'},{cookie:old});
 assert.equal(r.status,200);
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie:old}})})).json()).member,null);
 const fresh = r.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await auth({env:authEnv,request:new Request('https://test.invalid/api/auth?action=me',{headers:{cookie:fresh}})})).json()).member.id,1);
 await db.query('UPDATE members SET passphrase_h=$1 WHERE id=1',[await bcrypt.hash('test-password',4)]);
});

test('unauthenticated mutations rejected',async()=>{assert.equal((await request({season:2026,week:1,picks:[pick()]},'',false)).status,401);});
test('all five slots persist atomically with server lines, and reload',async()=>{
 const body={season:2026,week:1,picks:['Favorite','Dog','Over','Under'].map(b=>pick(b)).concat({bet_type:'Super Lock',prop:{market:'receptions',player:'Test Receiver',side:'over',line:3.5,game_key:key(1),book:'fanduel'}})};
 assert.equal((await request(body)).status,200);
 const rows=(await db.query('SELECT * FROM picks')).rows;assert.equal(rows.length,5);assert.equal(Number(rows.find(p=>p.bet_type==='Favorite').line),-3.5);assert.equal(rows.find(p=>p.bet_type==='Super Lock').price,110);
 assert.equal(fetchCalls,2,'one odds and one prop fetch per whole card');
 assert.equal((await request(null,'season=2026&week=1',true,'GET')).body.picks.length,5);
});
test('cannot replace a started pick with a Sunday game',async()=>{await insertOld();assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,423);assert.equal((await db.query('SELECT pick_text FROM picks')).rows[0].pick_text,'old');});
test('cannot replace an already graded pick',async()=>{await insertOld({result:'L',i:1});assert.equal((await request({season:2026,week:1,picks:[pick()]})).body.error,'pick-graded');});
test('cannot remove a started pick',async()=>{await insertOld();assert.equal((await request({season:2026,week:1,bet_type:'Favorite'},'action=remove')).status,423);});
test('future pick can be edited then removed',async()=>{await insertOld({i:1});assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);assert.equal((await request({season:2026,week:1,bet_type:'Favorite'},'action=remove')).body.removed,1);});
test('concurrent edit rejects entire card without partial inserts',async()=>{
 await insertOld({i:1});beforeWrite=()=>db.query("UPDATE picks SET locked_at='2026-09-11T11:00:00Z'");
 assert.equal((await request({season:2026,week:1,picks:[pick(),pick('Over')]})).status,409);
 assert.equal((await db.query('SELECT * FROM picks')).rows.length,1);
});
test('provider outage cannot accept fabricated ordinary or Super Lock lines',async()=>{
 oddsDown=true; assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,503);
 assert.equal((await request({season:2026,week:1,picks:[{bet_type:'Super Lock',line_pick:{...pick(),bet:'Favorite'}}]})).status,503);
 propsDown=true;assert.equal((await request({season:2026,week:1,picks:[{bet_type:'Super Lock',prop:{market:'receptions',player:'Test Receiver',side:'over',line:null,game_key:key(1)}}]})).status,503);
 assert.equal((await db.query('SELECT * FROM picks')).rows.length,0);
});
test('kickoff guard reuses the board the line check already fetched',async()=>{
 // ESPN is unreachable from the colo (the normal production case) and the odds
 // board answers once — the line check — then goes cold. Re-fetching it for the
 // kickoff guard is what used to 503 with "Can't verify game times right now"
 // while the picker was looking at a perfectly good board.
 // Past the isolate's 60s scoreboard cache, so the guard really re-derives.
 mock.timers.setTime(Date.parse('2026-09-11T12:02:00Z'));
 board=[]; oddsFailAfter=1;
 assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);
 assert.equal(Number((await db.query('SELECT line FROM picks')).rows[0].line),-3.5);
});
test('kickoff guard falls back to the stored board, and fails closed without one',async()=>{
 // Nothing upstream is reachable: no ESPN, no live odds. A free-text Super Lock
 // needs no line check, so the guard is on its own — Neon's last-good board
 // still carries the kickoffs it needs.
 mock.timers.setTime(Date.parse('2026-09-11T12:04:00Z'));
 board=[]; oddsDown=true;
 const superLock={season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Someone over 40.5 rushing yards',price:-110,game_key:key(1)}]};
 const closed=await request(superLock);
 assert.equal(closed.status,503); assert.equal(closed.body.error,'scoreboard-unavailable');
 assert.equal((await db.query('SELECT * FROM picks')).rows.length,0);
 await db.exec('CREATE TABLE odds_snapshot(id INT PRIMARY KEY, payload JSONB NOT NULL, fetched_at TIMESTAMPTZ DEFAULT NOW())');
 await db.query('INSERT INTO odds_snapshot(id,payload) VALUES(1,$1::jsonb)',[JSON.stringify({source:'sharpapi',games:liveGames})]);
 assert.equal((await request(superLock)).status,200);
 // A Monday game is still refused off the stored board, and a game it doesn't
 // carry still fails closed rather than slipping past the guard unverified.
 assert.equal((await request({season:2026,week:1,picks:[{...superLock.picks[0],game_key:key(2)}]})).body.error,'monday-not-allowed');
 const missing=await request({season:2026,week:1,picks:[{...superLock.picks[0],game_key:'Green Bay Packers@Chicago Bears'}]});
 assert.equal(missing.status,503); assert.equal(missing.body.reason,'unknown-kickoff');
});
test('a stale pick on a game this week does not carry cannot lock its own slot',async()=>{
 // Mock-board leftovers: rows whose game_key is not on this week's slate at all
 // (a dry run against /api/odds?mock=1). They used to fail the kickoff guard —
 // it could not verify their kickoff — so every edit of that slot 503'd and the
 // card could never be cleared.
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,locked_at) VALUES(1,2026,1,'Favorite','Buffalo Bills -2.5','Kansas City Chiefs@Buffalo Bills','2026-09-05T01:00:00Z')");
 assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);
 assert.equal((await db.query('SELECT pick_text FROM picks')).rows[0].pick_text,'New York Giants -3.5');
});
test('a stale pick can be removed from the card',async()=>{
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,locked_at) VALUES(1,2026,1,'Over','Dallas Cowboys / Philadelphia Eagles O47.5','Dallas Cowboys@Philadelphia Eagles','2026-09-05T01:00:00Z')");
 assert.equal((await request({season:2026,week:1,bet_type:'Over'},'action=remove')).body.removed,1);
 assert.equal((await db.query('SELECT * FROM picks')).rows.length,0);
});
test('a partial board still fails closed on an unverifiable existing pick',async()=>{
 // Only the pregame betting board is reachable, and a game drops off it the
 // moment it starts — so absence there is not proof the pick is stale.
 mock.timers.setTime(Date.parse('2026-09-11T12:06:00Z'));
 board=[];
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,locked_at) VALUES(1,2026,1,'Favorite','stale','Kansas City Chiefs@Buffalo Bills','2026-09-05T01:00:00Z')");
 const r=await request({season:2026,week:1,picks:[pick()]});
 assert.equal(r.status,503); assert.equal(r.body.reason,'unknown-kickoff');
 assert.equal((await db.query('SELECT pick_text FROM picks')).rows[0].pick_text,'stale');
 assert.equal((await request({season:2026,week:1,bet_type:'Favorite'},'action=remove')).status,503);
});
test('a game on the slate without a usable kickoff still holds its slot',async()=>{
 // Present but unverified is not the same as absent: only absence from a
 // complete slate means "stale". A bad kickoff still fails closed.
 mock.timers.setTime(Date.parse('2026-09-11T12:08:00Z'));
 board=[{...events[0]},{...events[1],kickoff:null},{...events[2]}];
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,locked_at) VALUES(1,2026,1,'Favorite','old','Dallas Cowboys@New York Giants','2026-09-05T01:00:00Z')");
 const r=await request({season:2026,week:1,picks:[pick('Favorite',0)]});
 assert.equal(r.status,503); assert.equal(r.body.reason,'unknown-kickoff');
 // Re-warm the isolate's 60s scoreboard cache with the good slate, so this
 // doctored board can't leak into a later test through it.
 mock.timers.setTime(Date.parse('2026-09-11T12:10:00Z'));
 board=events; await request({season:2026,week:1,picks:[pick('Dog')]});
});
test('a started game on the full slate still locks its slot',async()=>{
 // The complete-board rule must not become a way around the kickoff guard: the
 // game IS on the slate, it has simply already kicked off.
 await insertOld({i:0});
 assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,423);
 assert.equal((await request({season:2026,week:1,bet_type:'Favorite'},'action=remove')).status,423);
});
test('Monday game rejected in Central time',async()=>{assert.equal((await request({season:2026,week:1,picks:[pick('Favorite',2)]})).body.error,'monday-not-allowed');});
test('unknown game rejected',async()=>{assert.equal((await request({season:2026,week:1,picks:[{...pick(),game_key:'Unknown@Unknown'}]})).status,422);});
test('invalid periods, duplicates and null picks rejected cleanly',async()=>{
 for (const body of [{season:2025,week:1,picks:[pick()]},{season:2026,week:99,picks:[pick()]},{season:2026,week:1,picks:[pick(),pick()]},{season:2026,week:1,picks:[null]}])assert.equal((await request(body)).status,400);
});
test('cutoff equality locks submissions',async()=>{mock.timers.setTime(Date.parse('2026-09-13T17:00:00Z'));assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,423);});
test('other member picks remain hidden before cutoff and reveal after',async()=>{
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text) VALUES(2,2026,1,'Favorite','secret')");
 assert.equal((await request(null,'season=2026&week=1',true,'GET')).body.picks.length,0);
 mock.timers.setTime(Date.parse('2026-09-13T17:00:00Z'));assert.equal((await request(null,'season=2026&week=1',true,'GET')).body.picks.length,1);
});
test('early settled W/L/P reach season standings without exposing ungraded picks',async()=>{
 await db.query(`INSERT INTO picks(member_id,season,week,bet_type,pick_text,result) VALUES
 (2,2026,1,'Favorite','settled win','W'),(2,2026,1,'Dog','settled loss','L'),
 (2,2026,1,'Under','settled push','P'),(2,2026,1,'Super Lock','private future prop',NULL)`);
 for(const signed of [true,false]) {
  for(const query of ['season=2026','season=2026&week=1']) {
   const response=await request(null,query,signed,'GET');
   assert.equal(response.status,200);
   assert.deepEqual(response.body.picks.map(p=>p.result).sort(),['L','P','W']);
   assert.ok(!JSON.stringify(response.body.picks).includes('private future prop'));
  }
 }
});
test('winner and payout wait for cutoff and every grade',()=>{
 let ps=[{week:1,member_id:1,bet_type:'Favorite',result:'W'},{week:1,member_id:2,bet_type:'Favorite',result:null}];
 assert.equal(weeklyWinner(weeklyMemberRecords([1,2],ps,{locked:true})),null);
 ps[1].result='L';assert.equal(computeWeeklyWinners(ps,[1,2],2026,env)[1],null);
 mock.timers.setTime(Date.parse('2026-09-13T18:00:00Z'));assert.equal(computeWeeklyWinners(ps,[1,2],2026,env)[1].member_id,1);
});
test('Wednesday opener, Sunday cutoff, DST and rollover match NFL week',()=>{
 assert.equal(SEASON_2026_KICKOFF.toISOString(),'2026-09-10T00:20:00.000Z');
 assert.equal(pickCutoff(2026,1).toISOString(),'2026-09-13T17:00:00.000Z');
 assert.equal(pickCutoff(2026,8).toISOString(),'2026-11-01T18:00:00.000Z');
 assert.equal(currentNflWeek(new Date('2026-09-10T00:20Z')).week,1);
 assert.deepEqual(weeksToGrade(new Date('2026-09-15T09:00Z')),[1,2]);
});

if (process.env.RUN_BROWSER === '1') test('browser: real login, board save/reload, card removal, password reset, outage feedback and mobile navigation', async()=>{
 const { createServer } = await import('node:http');
 const { readFile } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 let chromium;try {({chromium}=await import('playwright'));}catch {const {execFileSync}=await import('node:child_process');const {pathToFileURL}=await import('node:url');const root=execFileSync('npm',['root','-g']).toString().trim();({chromium}=await import(pathToFileURL(root+'/playwright/index.mjs').href));}
 const server=createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://localhost');let response;
   const parts=[];for await(const chunk of req)parts.push(chunk);
   const webRequest=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(parts.length?{body:Buffer.concat(parts)}:{})});
   if(url.pathname==='/api/auth')response=await auth({env,request:webRequest});
   else if(url.pathname==='/api/picks')response=await picks({env,request:webRequest});
   else if(url.pathname==='/api/config')response=Response.json({season:2026,week:1,status:'in-season',cutoff:'2026-09-13T17:00:00Z',preseasonTest:false});
   else if(url.pathname==='/api/odds')response=Response.json({source:'sharpapi',games:liveGames,fetched_at:new Date().toISOString(),live:true});
   else if(url.pathname==='/api/scores')response=Response.json({games:events.map(e=>({...e,state:'pre'}))});
   else if(url.pathname==='/api/props')response=await globalThis.fetch('https://test.invalid/api/props');
   else if(url.pathname==='/api/warroom')response=Response.json({season:2026,week:1,revealed:false,members:[],cutoff:'2026-09-13T17:00:00Z'});
   else if(url.pathname==='/api/push')response=Response.json({subscribed:true});
   else if(url.pathname==='/api/pot'||url.pathname==='/api/settlement')response=Response.json({error:'not-configured'},{status:401});
   else if(url.pathname.startsWith('/api/'))response=Response.json({error:'unknown-route'},{status:404});
   else {const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const data=await readFile(new URL('../public/'+file,import.meta.url));response=new Response(data,{headers:{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'application/javascript'}});}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end(String(e));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://localhost:${server.address().port}`;
 const browser=await chromium.launch();
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-09-11T12:00:00Z')});
  await page.goto(base);await page.waitForSelector('#login-btn');
  await page.locator('#login-btn').click();assert.equal(await page.locator('#login-name option').count(),8);
  await page.selectOption('#login-name','Jacob');await page.fill('#login-pass','test-password');await page.click('#login-submit');
  await page.waitForFunction(()=>state.user?.name==='Jacob');
  await page.locator('.side-nav-link[data-view="thisweek"]').click();
  const button=page.locator('.pick-btn[data-bet="Favorite"][data-game="Dallas Cowboys@New York Giants"]').first();
  await button.waitFor();await button.click();await page.waitForFunction(()=>!!currentMyPicks.Favorite);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM picks')).rows[0].n,1);
  await page.reload();await page.waitForFunction(()=>state.user?.name==='Jacob');
  await page.locator('.side-nav-link[data-view="thisweek"]').click();await page.waitForFunction(()=>!!currentMyPicks.Favorite);
  assert.equal(await page.evaluate(()=>currentMyPicks.Favorite.pick_text),'New York Giants -3.5');
  // My Card's own remove buttons, including on a leftover row whose game this
  // week's board doesn't carry — the only way to clear one of those, since
  // there is no board button to tap for a game that isn't on the board.
  await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,side,line,book,price,locked_at) VALUES(1,2026,1,'Over','Kansas City Chiefs / Buffalo Bills O48.5','Kansas City Chiefs@Buffalo Bills','over',48.5,'fanduel',-110,'2026-09-05T01:00:00Z')");
  await page.reload();await page.waitForFunction(()=>state.user?.name==='Jacob');
  await page.locator('.side-nav-link[data-view="thisweek"]').click();await page.waitForFunction(()=>!!currentMyPicks.Over);
  await page.evaluate(()=>{document.getElementById('my-card').open=true;});
  await page.locator('#my-card-body .slot-drop[data-drop="Over"]').click();
  await page.waitForFunction(()=>!currentMyPicks.Over);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM picks WHERE bet_type='Over'")).rows[0].n,0);
  // Removing from the card also drops the board's highlight for that slot.
  await page.locator('#my-card-body .slot-drop[data-drop="Favorite"]').click();
  await page.waitForFunction(()=>!currentMyPicks.Favorite&&!document.querySelector('.pick-btn.picked[data-bet="Favorite"]'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM picks')).rows[0].n,0);
  await button.click();await page.waitForFunction(()=>!!currentMyPicks.Favorite);
  await page.locator('.pick-btn.picked[data-bet="Favorite"]').first().click();await page.waitForFunction(()=>!currentMyPicks.Favorite);
  oddsDown=true;await page.locator('.pick-btn[data-bet="Favorite"][data-game="Dallas Cowboys@New York Giants"]').first().click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Cannot verify'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM picks')).rows[0].n,0);oddsDown=false;
  for(const view of ['warroom','standings','lifetime','rules']){await page.locator(`.side-nav-link[data-view="${view}"]`).click();await page.waitForTimeout(80);}
  await page.setViewportSize({width:390,height:844});await page.locator('.bottom-nav-link[data-view="thisweek"]').click();
  await page.screenshot({path:join(tmpdir(),'lock-league-week1-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  // Locked-out member redeems a code the commissioner relayed, on a phone.
  await db.query("INSERT INTO password_resets(member_id,code_h,channel,expires_at) VALUES(1,$1,'admin',NOW()+INTERVAL '20 minutes')",
   [await bcrypt.hash('ABCDEFGH',4)]);
  await page.evaluate(()=>logout());await page.waitForSelector('#login-btn-mobile');
  await page.locator('#login-btn-mobile').click();await page.locator('#login-forgot').click();
  await page.selectOption('#reset-name','Jacob');
  await page.fill('#reset-code','abcd-efgh');await page.fill('#reset-next','recovered-password');
  await page.click('#reset-submit');
  await page.waitForFunction(()=>state.user?.name==='Jacob');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM password_resets WHERE used_at IS NOT NULL')).rows[0].n,1);
  assert.ok(await bcrypt.compare('recovered-password',(await db.query('SELECT passphrase_h FROM members WHERE id=1')).rows[0].passphrase_h));
  await db.query('UPDATE members SET passphrase_h=$1 WHERE id=1',[await bcrypt.hash('test-password',4)]);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('ambiguous Super Lock and null request bodies return 400',async()=>{
 assert.equal((await request(null)).status,400);
 const r=await request({season:2026,week:1,picks:[{bet_type:'Super Lock',prop:{market:'receptions'},line_pick:{bet:'Favorite'}}]});assert.equal(r.body.error,'ambiguous-super-lock');
});
test('free-text Super Lock preserves manual workflow',async()=>{
 assert.equal((await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Honor-system test prop',price:150}]})).status,200);
 assert.equal((await request({season:2026,week:1,result:'W'},'action=mark-super-lock')).status,200);
 assert.equal((await db.query('SELECT result,prop_meta FROM picks')).rows[0].result,'W');
});
test('game-line Super Lock persists correct grading metadata',async()=>{
 const r=await request({season:2026,week:1,picks:[{bet_type:'Super Lock',line_pick:{bet:'Over',side:'over',game_key:key(1),book:'fanduel'}}]});
 assert.equal(r.status,200);assert.equal(r.body.picks[0].prop.kind,'total');assert.equal(Number((await db.query('SELECT line FROM picks')).rows[0].line),44.5);
});
test('repeated valid edits preserve full timestamp precision',async()=>{
 for(let i=0;i<3;i++)assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM picks')).rows[0].n,1);
});

test('PostgreSQL clock follows fixture time so deadline tests do not age out',async()=>{
 const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
 assert.ok(Math.abs(Date.parse(now)-Date.now())<1000,`database clock ${now}`);
});

test('shared backup lease limits concurrent consumers to one provider request', async t => {
 const { supplementMissingBooks } = await import('../functions/api/odds.js');
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{
  calls++;
  return Response.json([{away_team:events[1].away,home_team:events[1].home,commence_time:events[1].kickoff,bookmakers:[{key:'draftkings',last_update:new Date().toISOString(),markets:[{key:'spreads',outcomes:[{name:events[1].home,point:-3.5,price:-110},{name:events[1].away,point:3.5,price:-110}]},{key:'totals',outcomes:[{name:'Over',point:44.5,price:-110},{name:'Under',point:44.5,price:-110}]}]}]}]);
 });
 const primary={games:[liveGames[1]]}, config={...env,DATABASE_URL:'test-db',ODDS_API_KEY:'test-key'};
 await Promise.all(Array.from({length:6},()=>supplementMissingBooks(config,primary)));
 const filled=await supplementMissingBooks(config,primary);
 assert.equal(calls,1);
 assert.equal(filled.games[0].books.draftkings.total.point,44.5);
 // A failed fetch also holds the lease; repeated consumers cannot hammer quota.
 await db.exec("UPDATE odds_backup_snapshot SET attempted_at='epoch',payload=NULL");
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:429});});
 assert.deepEqual(await supplementMissingBooks(config,primary),primary);
 assert.deepEqual(await supplementMissingBooks(config,primary),primary);
 assert.equal(calls,2);
});

test('season Venmo collections and payouts remain separate and enforce ledger permissions', async () => {
 const { onRequest: pot } = await import('../functions/api/pot.js');
 const call = async (id, action='', body=null) => {
  const r = await pot({env,request:new Request(`https://test.invalid/api/pot?season=2026&action=${action}`,{
   method:body?'POST':'GET', headers:{cookie:await cookieFor(id)}, ...(body?{body:JSON.stringify({season:2026,...body})}:{})
  })}); return {status:r.status,body:await r.json()};
 };
 await call(1); // run actual schema migrations
 await db.exec('DELETE FROM season_payouts; DELETE FROM season_entries; DELETE FROM pot_entries; DELETE FROM pot_config');
 assert.equal((await call(2,'config',{collector_id:2})).status,200);
 assert.equal((await call(1,'set-paid',{member_id:1,paid:true,fund:'season'})).status,200);
 let data=(await call(1)).body;
 assert.equal(data.season_pot.roster.find(m=>m.id===1).paid,true);
 assert.equal(data.weekly.me.paid,false,'season entry must not mark weekly buy-in paid');
 assert.equal((await call(1,'set-paid',{member_id:2,paid:true,fund:'season'})).status,403);
 assert.equal((await call(1,'set-paid',{member_id:1,paid:true,fund:'typo'})).status,400);
 assert.equal((await call(1,'season-recipient',{place:1,member_id:1})).status,403);
 assert.equal((await call(2,'season-recipient',{place:1,member_id:1})).status,200);
 assert.equal((await call(2,'season-recipient',{place:2,member_id:1})).status,409);
 assert.equal((await call(2,'season-recipient',{place:4,member_id:1})).status,400);
 assert.equal((await call(2,'season-paid',{place:1,member_id:2,paid:true})).status,409,'stale recipient rejected');
 assert.equal((await call(1,'season-paid',{place:1,member_id:1,paid:true})).status,200);
 assert.equal((await call(2,'season-recipient',{place:1,member_id:2})).status,409,'paid award protected');
 data=(await call(1)).body;
 assert.equal(data.season_pot.payouts[0].amount,500);
 assert.equal(data.season_pot.payouts[0].paid,true);
 assert.ok(data.season_pot.payouts[0].paid_at);
 assert.equal((await call(1,'season-paid',{place:1,member_id:1,paid:false})).status,200);
 assert.equal((await call(2,'season-recipient',{place:1,member_id:2})).status,200);
 assert.equal((await call(1,'season-paid',{place:1,member_id:2,paid:true})).status,403);
 assert.equal((await call(1,'season-paid',{place:1,member_id:1,paid:true})).status,409);
});

test('new custom locks require valid saved American odds for units',async()=>{
 for(const price of [undefined,0,-90,99,-121,100.5]) {
  const r=await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Test custom prop',price}]});
  assert.equal(r.status,400);
 }
 const r=await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Test custom prop',price:250}]});
 assert.equal(r.status,200);
 assert.equal((await db.query("SELECT price FROM picks WHERE bet_type='Super Lock'")).rows[0].price,250);
});
test('board picks cannot save without a provider price',async()=>{
 const total=liveGames[1].books.fanduel.total;
 const previous=total.underPrice;
 try {
  total.underPrice=null;
  assert.equal((await request({season:2026,week:1,picks:[pick('Under')]})).status,503);
  assert.equal((await db.query('SELECT * FROM picks')).rows.length,0);
 } finally {total.underPrice=previous;}
});

test('changed displayed quote rejects the entire submission and preserves saved picks', async()=>{
 await insertOld({i:1});
 const before=(await db.query('SELECT * FROM picks')).rows;
 const result=await request({season:2026,week:1,picks:[{...pick(),book:'fanduel',expected_quote:{book:'fanduel',line:-3.5,price:-115}}]});
 assert.equal(result.status,409);assert.equal(result.body.error,'quote-changed');
 assert.deepEqual((await db.query('SELECT * FROM picks')).rows,before);
 const retry=await request({season:2026,week:1,picks:[{...pick(),book:'fanduel',expected_quote:{book:'fanduel',line:-3.5,price:-110}}]});
 assert.equal(retry.status,200);
});
test('missing requested sportsbook never silently changes to another book',async()=>{
 const result=await request({season:2026,week:1,picks:[{...pick(),book:'draftkings'}]});
 assert.equal(result.status,422);assert.equal((await db.query('SELECT * FROM picks')).rows.length,0);
});

test('two members racing for the same Super Lock produce exactly one owner',async()=>{
 const other=await cookieFor(2);
 const submit=c=>picks({env,request:new Request('https://test.invalid/api/picks',{method:'POST',headers:{cookie:c},body:JSON.stringify({season:2026,week:1,picks:[{bet_type:'Super Lock',prop:{market:'receptions',player:'Test Receiver',side:'over',line:3.5,book:'fanduel',game_key:key(1)}}]})})});
 const results=await Promise.all([submit(cookie),submit(other)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const loser=results.find(r=>r.status===409);assert.equal((await loser.json()).error,'super-lock-taken');
 assert.equal((await db.query("SELECT * FROM picks WHERE bet_type='Super Lock'")).rows.length,1);
});
test('claims ignore books, thresholds, common wording, and token order; opposite sides differ',async()=>{
 const variants=['Drake Maye o25.5 rush yds','Drake Maye OVER 30.5 Rushing Yards DraftKings -110','Over 40.5 rushing yards Drake Maye','Drake Maye 35+ rushing yards'];
 const keys=[];for(const text of variants)keys.push((await db.query('SELECT ll_super_lock_key($1) AS key',[text])).rows[0].key);
 assert.equal(new Set(keys).size,1);
 const under=(await db.query("SELECT ll_super_lock_key('Drake Maye u25.5 rush yds') AS key")).rows[0].key;
 assert.notEqual(under,keys[0]);
 const passing=(await db.query("SELECT ll_super_lock_key('Drake Maye o225.5 pass yds') AS key")).rows[0].key;
 assert.notEqual(passing,keys[0]);
});
test('taken lock rolls back every slot and preserves the loser original card',async()=>{
 await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Drake Maye over 25.5 rushing yards',price:110}]});
 cookie=await cookieFor(2);
 await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Sam Darnold under 10.5 rushing yards',price:110},pick()]});
 const before=(await db.query('SELECT * FROM picks ORDER BY id')).rows;
 const denied=await request({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Drake Maye o35.5 rush yds DraftKings',price:120},pick('Over')]});
 assert.equal(denied.status,409);assert.equal(denied.body.error,'super-lock-taken');
 assert.deepEqual((await db.query('SELECT * FROM picks ORDER BY id')).rows,before);
});
test('owner can change their line and another member can claim a released lock',async()=>{
 const lock=pick_text=>({season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text,price:110}]});
 assert.equal((await request(lock('Drake Maye o25.5 rush yds'))).status,200);
 assert.equal((await request(lock('Drake Maye o35.5 rush yds'))).status,200);
 assert.equal((await request({season:2026,week:1,bet_type:'Super Lock'},'action=remove')).status,200);
 cookie=await cookieFor(2);
 assert.equal((await request(lock('Drake Maye over 30.5 rushing yards'))).status,200);
});

test('every supported prop stat claims the same canonical and long-form custom wording',async()=>{
 const {PROP_DEFS}=await import('../functions/_shared/props.js');
 for(const [market,def] of Object.entries(PROP_DEFS)) {
  const standard=market==='anytime_td'?'Test Player anytime TD':`Test Player o10.5 ${def.unit}`;
  const custom=market==='anytime_td'?'Test Player anytime touchdown':`Test Player Over 20.5 ${def.label}`;
  const rows=await db.query('SELECT ll_super_lock_key($1) AS a,ll_super_lock_key($2) AS b',[standard,custom]);
  assert.equal(rows.rows[0].a,rows.rows[0].b,market);
 }
});

test('Super Lock exclusivity is weekly and does not restrict ordinary picks or old history',async()=>{
 const custom={season:2026,week:1,picks:[{bet_type:'Super Lock',pick_text:'Drake Maye o25.5 rush yds',price:110}]};
 assert.equal((await request(custom)).status,200);
 await db.query("INSERT INTO picks(member_id,season,week,bet_type,pick_text) VALUES(2,2026,2,'Super Lock',$1),(1,2023,1,'Super Lock',$1),(2,2023,1,'Super Lock',$1)",[custom.picks[0].pick_text]);
 assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);
 cookie=await cookieFor(2);assert.equal((await request({season:2026,week:1,picks:[pick()]})).status,200);
});
