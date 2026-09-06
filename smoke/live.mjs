// Read-only Week 1 readiness probe. HTTP 200 alone is not proof of an API:
// Cloudflare's SPA fallback returns the homepage for missing API routes.
import { suite } from './assert.mjs';
import { readFile } from 'node:fs/promises';
const schedule=JSON.parse(await readFile(new URL('./week1-schedule.json',import.meta.url),'utf8')).games;
const key=g=>`${g.away}@${g.home}`;
const j=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json().catch(()=>null)};};
export async function run(base='https://lock-league.pages.dev') {
 const s=suite(`live — Week 1 readiness (${base})`);
 const odds=await j(`${base}/api/odds`);const games=odds.body?.games||[];
 s.ok('odds is real JSON with a live provider',odds.status===200&&odds.body?.source!=='mock'&&games.length>0);
 const eligible=schedule.filter(g=>new Date(g.kickoff).toLocaleDateString('en-US',{weekday:'short',timeZone:'America/Chicago'})!=='Mon'&&Date.parse(g.kickoff)>Date.now());
 const missing=eligible.filter(e=>!games.some(g=>key(g)===key(e)));
 s.ok('every upcoming eligible Week 1 game appears',missing.length===0,missing.map(key).join(', '));
 for(const g of games){
  const books=Object.values(g.books||{});
  s.ok(`${key(g)} has spread and game-total lines`,books.some(b=>Number.isFinite(b.spread?.line))&&books.some(b=>Number.isFinite(b.total?.point)&&b.total.point>=30));
  const pr=await j(`${base}/api/props?game_key=${encodeURIComponent(key(g))}`);
  s.ok(`${key(g)} prop endpoint is JSON`,pr.status===200&&Array.isArray(pr.body?.markets));
  if(Date.parse(g.kickoff)>Date.now()&&Date.parse(g.kickoff)-Date.now()<48*3600000)
   s.ok(`${key(g)} near-kickoff props available`,pr.body?.markets?.length>0);
  for(const m of pr.body?.markets||[])s.ok(`${key(g)} ${m.market} valid players`,m.players?.length>0&&m.players.every(p=>p.player&&!/^over$|^under$/i.test(p.player)&&Array.isArray(p.alts)));
 }
 for(const [name,path,status] of [['config','/api/config',200],['auth','/api/auth?action=me',200],['picks','/api/picks?season=2026&week=1',200],['warroom','/api/warroom',401],['settlement','/api/settlement',401],['pot','/api/pot',401],['scores','/api/scores',200]]) {
  const r=await j(base+path);s.ok(`${name}: expected status and JSON`,r.status===status&&!!r.body,`status=${r.status}, json=${!!r.body}`);
 }
 return s;
}
