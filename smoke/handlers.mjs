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
const { onRequest: picks } = await import('../functions/api/picks.js');
const { onRequest: auth } = await import('../functions/api/auth.js');
const { sign } = await import('../functions/_shared/auth.js');
const { computeWeeklyWinners } = await import('../functions/api/settlement.js');
const { weeklyMemberRecords, weeklyWinner } = await import('../functions/_shared/standings.js');
const { pickCutoff, currentNflWeek, weeksToGrade, SEASON_2026_KICKOFF } = await import('../functions/_shared/nfl.js');
const bcrypt = (await import('bcryptjs')).default;
const env = { SESSION_SECRET: 'test-only-session-secret' };
let cookie, oddsDown = false, propsDown = false;
let fetchCalls = 0;
const liveGames = events.map(e => ({ ...e, books: { fanduel: { spread: { fav: e.home, line: -3.5, favPrice: -110, dogPrice: -110 }, total: { point: 44.5, overPrice: -110, underPrice: -110 } } } }));
mock.method(globalThis, 'fetch', async url => {
 fetchCalls++;
 const props = String(url).includes('/api/props');
 if (props ? propsDown : oddsDown) throw new Error('provider unavailable');
 return Response.json(props ? {markets:[{ market:'receptions', kind:'ou', players:[{player:'Test Receiver',line:3.5,fanduel:{line:3.5,over:110,under:-110},alts:[]}]}]} : { source: 'sharpapi', games: liveGames });
});
const key = i => `${events[i].away}@${events[i].home}`;
const pick = (bet_type='Favorite', i=1) => ({ bet_type, game_key:key(i), side:({Favorite:'fav',Dog:'dog',Over:'over',Under:'under'})[bet_type], line:999, price:999, pick_text:'fabricated' });
async function request(body, action='', signed=true, method='POST') {
 const r = await picks({env,request:new Request(`https://test.invalid/api/picks${action ? '?'+action : ''}`,{method,headers:signed?{cookie}: {},...(method==='POST'?{body:JSON.stringify(body)}:{})})});
 return {status:r.status,body:await r.json()};
}
async function insertOld({result=null, i=0, bet='Favorite'}={}) {
 await db.query('INSERT INTO picks(member_id,season,week,bet_type,pick_text,game_key,result,locked_at) VALUES(1,2026,1,$1,$2,$3,$4,$5)',[bet,'old',key(i),result,'2026-09-09T12:00:00Z']);
}
before(async()=>{
 await db.exec(`CREATE TABLE members(id serial PRIMARY KEY,name text,passphrase_h text);
 CREATE TABLE picks(id serial PRIMARY KEY,member_id int,season int,week int,bet_type text,pick_text text,game_key text,side text,line numeric,book text,price int,result text,graded_at timestamptz,locked_at timestamptz, UNIQUE(member_id,season,week,bet_type));`);
 await db.query('INSERT INTO members(id,name,passphrase_h) VALUES(1,$1,$2),(2,$3,$2)',['Jacob',await bcrypt.hash('test-password',4),'Jared']);
});
beforeEach(async()=>{
 mock.timers.reset(); mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-11T12:00:00Z')});
 cookie=`ll_session=${await sign(env,'1')}`;
 await db.exec('DELETE FROM picks'); oddsDown=false; propsDown=false; board=events; fetchCalls=0; beforeWrite=null; statements=[];
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

if (process.env.RUN_BROWSER === '1') test('browser: real login, board save/reload/remove, outage feedback and mobile navigation', async()=>{
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
  await page.locator('.pick-btn.picked[data-bet="Favorite"]').first().click();await page.waitForFunction(()=>!currentMyPicks.Favorite);
  oddsDown=true;await page.locator('.pick-btn[data-bet="Favorite"][data-game="Dallas Cowboys@New York Giants"]').first().click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Cannot verify'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM picks')).rows[0].n,0);oddsDown=false;
  for(const view of ['warroom','standings','lifetime','rules']){await page.locator(`.side-nav-link[data-view="${view}"]`).click();await page.waitForTimeout(80);}
  await page.setViewportSize({width:390,height:844});await page.locator('.bottom-nav-link[data-view="thisweek"]').click();
  await page.screenshot({path:join(tmpdir(),'lock-league-week1-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
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
