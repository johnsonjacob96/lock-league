import { sql } from '../_shared/db.js';
import { verifyCookie,json } from '../_shared/auth.js';
import { ensureExtras } from '../_shared/migrations.js';
import { currentNflWeek,seasonTypeFor } from '../_shared/nfl.js';
import { fetchScoreboard } from '../_shared/grader.js';
import { ensureParlays,validateSlip,refreshParlays } from '../_shared/parlays.js';
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export async function onRequest({request,env}) {
 const memberId=await verifyCookie(env,request.headers.get('cookie'));
 if(!memberId)return json({error:'Sign in to view parlays.'},{status:401});
 await ensureExtras(env);await ensureParlays(env);
 const members=await sql(env)`SELECT id,name,is_admin FROM members ORDER BY name`;
 const me=members.find(m=>m.id===memberId);
 const url=new URL(request.url);
 if(request.method==='GET') {
  const cur=currentNflWeek(new Date(),env),season=Number(url.searchParams.get('season')||cur.season),week=Number(url.searchParams.get('week')||cur.week||1);
  if(!Number.isInteger(season)||season<2026||season>2100||!Number.isInteger(week)||week<1||week>18)return json({error:'Invalid season or week.'},{status:400});
  if(url.searchParams.has('image')) {
   const id=url.searchParams.get('image');if(!validId(id))return json({error:'Invalid slip.'},{status:400});
   const row=(await sql(env)`SELECT image FROM parlay_slips WHERE id=${id}`)[0];
   if(!row?.image)return json({error:'Slip image unavailable.'},{status:404});
   return new Response(Uint8Array.from(atob(row.image.split(',')[1]),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  const events=await fetchScoreboard(season,week,seasonTypeFor(env),env).catch(()=>[]);
  const games=await refreshParlays(env,season,week,events);
  const slips=await sql(env)`SELECT id,season,week,night,game_key,title,odds,legs,created_by,version,created_at,image IS NOT NULL AS has_image FROM parlay_slips WHERE season=${season} ORDER BY week DESC,created_at DESC LIMIT 500`;
  return json({season,week,members:members.map(({id,name})=>({id,name})),me:{id:memberId,admin:!!me?.is_admin},slips,games,schedule:events.map(e=>({key:`${e.away}@${e.home}`,kickoff:e.kickoff})),markets:[]});
 }
 if(request.method!=='POST')return json({error:'Method not allowed.'},{status:405});
 const raw=await request.text();if(raw.length>1600000)return json({error:'Slip is too large.'},{status:413});
 let body;try{body=JSON.parse(raw);}catch{return json({error:'Invalid request.'},{status:400});}
 if(!body||typeof body!=='object')return json({error:'Invalid request.'},{status:400});
 const action=url.searchParams.get('action')||'save';
 if(!validId(body.id))return json({error:'Invalid slip ID.'},{status:400});
 const existing=(await sql(env)`SELECT * FROM parlay_slips WHERE id=${body.id}`)[0];
 if(existing&&existing.created_by!==memberId&&!me?.is_admin)return json({error:'Only the uploader or commissioner can edit this slip.'},{status:403});
 if(existing&&(!Number.isInteger(body.version)||body.version<1))return json({error:'Refresh this slip before editing it.'},{status:409});
 if(action==='grade') {
  if(!existing)return json({error:'Slip not found.'},{status:404});
  if(!Number.isInteger(body.index)||!existing.legs[body.index]||![null,'W','L','P','V'].includes(body.result))return json({error:'Invalid leg result.'},{status:400});
  const legs=existing.legs.map((l,i)=>i===body.index?{...l,result:body.result,manual:body.result!==null}:l);
  const updated=await sql(env)`UPDATE parlay_slips SET legs=${JSON.stringify(legs)}::jsonb,version=version+1,updated_at=NOW() WHERE id=${body.id} AND version=${body.version} RETURNING id`;
  return updated.length?json({ok:true}):json({error:'This slip changed. Refresh and try again.'},{status:409});
 }
 if(action!=='save')return json({error:'Unknown action.'},{status:400});
 let clean;try{clean=validateSlip(body,members.map(m=>m.id));}catch(e){return json({error:e.message},{status:400});}
 if(existing) {
  // Keep grades when only the assignment changes. A corrected bet is regraded.
  clean.legs=clean.legs.map((l,i)=>{const old=existing.legs[i];return existing.game_key===clean.game_key&&existing.week===clean.week&&existing.season===clean.season&&old&&['player','market','side','line'].every(k=>old[k]===l[k])?{...old,member_id:l.member_id}:l;});
  const updated=await sql(env)`UPDATE parlay_slips SET season=${clean.season},week=${clean.week},night=${clean.night},game_key=${clean.game_key},title=${clean.title},odds=${clean.odds??null},legs=${JSON.stringify(clean.legs)}::jsonb,image=COALESCE(${clean.image??null},image),version=version+1,updated_at=NOW() WHERE id=${body.id} AND version=${body.version} RETURNING id`;
  return updated.length?json({ok:true}):json({error:'This slip changed. Refresh before editing again.'},{status:409});
 }
 const inserted=await sql(env)`INSERT INTO parlay_slips (id,season,week,night,game_key,title,odds,legs,image,created_by) VALUES (${clean.id},${clean.season},${clean.week},${clean.night},${clean.game_key},${clean.title},${clean.odds??null},${JSON.stringify(clean.legs)}::jsonb,${clean.image??null},${memberId}) ON CONFLICT(id) DO NOTHING RETURNING id`;
 return inserted.length?json({ok:true}):json({error:'This slip was already saved. Refresh to see it.'},{status:409});
}
