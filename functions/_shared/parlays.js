import { sql, ignoringConcurrentCreate } from './db.js';
import { PROP_DEFS, playerStatMap } from './props.js';
import { espnSummary } from './espn.js';
let ready=false;
export async function ensureParlays(env) {
 if(ready)return;
 await ignoringConcurrentCreate(sql(env)`CREATE TABLE IF NOT EXISTS parlay_slips (
 id UUID PRIMARY KEY, season INT NOT NULL, week INT NOT NULL, night TEXT NOT NULL,
 game_key TEXT NOT NULL, title TEXT NOT NULL, odds INT, legs JSONB NOT NULL,
 image TEXT, created_by INT NOT NULL REFERENCES members(id), version INT NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 ready=true;
}
export function validateSlip(body, memberIds) {
 if(!Number.isInteger(body.season)||body.season<2026||body.season>2100||!Number.isInteger(body.week)||body.week<1||body.week>18)throw Error('Choose a valid season and week.');
 if(!['Monday','Thursday'].includes(body.night))throw Error('Choose Monday or Thursday.');
 if(typeof body.title!=='string'||!body.title.trim()||body.title.length>100)throw Error('Enter a title (100 characters maximum).');
 if(typeof body.game_key!=='string'||body.game_key.length>160||body.game_key.split('@').length!==2||body.game_key.split('@').some(s=>!s.trim()))throw Error('Choose the game.');
 if(body.odds!=null&&(!Number.isInteger(body.odds)||Math.abs(body.odds)<100||Math.abs(body.odds)>1000000))throw Error('Enter valid American parlay odds.');
 if(!Array.isArray(body.legs)||body.legs.length<1||body.legs.length>25)throw Error('Add between 1 and 25 legs.');
 const legs=body.legs.map(l=>{
  if(l.market!=='game_total'&&(typeof l.player!=='string'||!l.player.trim()||l.player.length>150))throw Error('Enter the player or pick for every leg.');
  if(!PROP_DEFS[l.market]&&!['manual','game_total'].includes(l.market))throw Error('Choose a supported market or Custom.');
  if(!['over','under','atleast','yes'].includes(l.side))throw Error('Choose a valid direction.');
  if(l.market==='game_total'&&!['over','under'].includes(l.side))throw Error('Game totals use Over or Under.');
  if(l.market==='anytime_td'&&l.side!=='yes')throw Error('Anytime TD uses Yes.');
  if(!['anytime_td','manual'].includes(l.market)&&(!Number.isFinite(l.line)||l.line<0||l.line>2000||l.side==='yes'))throw Error('Enter a valid threshold.');
  if(l.member_id!=null&&!memberIds.includes(l.member_id))throw Error('Choose a league member for each assigned leg.');
  return {player:l.market==='game_total'?'Game total':l.player.trim(),market:l.market,side:l.side,line:['anytime_td','manual'].includes(l.market)?null:l.line,member_id:l.member_id??null,result:null};
 });
 if(body.image!=null&&(typeof body.image!=='string'||body.image.length>1500000||!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(body.image)))throw Error('Upload a JPEG slip smaller than 1 MB.');
 return {...body,title:body.title.trim(),legs};
}
export function legProgress(leg, summary, final=false, game=null) {
 if(leg.manual)return {result:leg.result,actual:leg.actual??null};
 if(leg.market==='game_total') {
  if(!game||!['in','post'].includes(game.state)||![game.away_score,game.home_score].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0))return {result:null,actual:null};
  const actual=game.away_score+game.home_score;
  return {actual,result:game.state!=='post'?null:actual===leg.line?'P':(leg.side==='under'?actual<leg.line:actual>leg.line)?'W':'L'};
 }
 const def=PROP_DEFS[leg.market];
 if(!def||!summary)return {result:null,actual:null};
 const stats=playerStatMap(summary.boxscore,leg.player);
 if(!stats)return {result:null,actual:null};
 // Never turn a missing statistical category into an automatic zero/loss.
 if(!def.stat.some(k=>Number.isFinite(stats[k])))return {result:null,actual:null};
 const actual=def.stat.reduce((s,k)=>s+(Number.isFinite(stats[k])?stats[k]:0),0);
 if(!final)return {result:null,actual};
 const hit=leg.side==='yes'?actual>=1:leg.side==='atleast'?actual>=leg.line:leg.side==='under'?actual<leg.line:actual>leg.line;
 return {actual,result:hit?'W':!['yes','atleast'].includes(leg.side)&&actual===leg.line?'P':'L'};
}
export async function refreshParlays(env,season,week,events) {
 await ensureParlays(env);
 const rows=await sql(env)`SELECT id,game_key,legs,version FROM parlay_slips WHERE season=${season} AND week=${week}`;
 const games={};
 for(const key of new Set(rows.map(r=>r.game_key))) {
  const ev=events.find(e=>`${e.away}@${e.home}`===key);
  if(!ev)continue;
  const gp=ev.state==='in'||ev.state==='post'?await espnSummary(ev.id,env).catch(()=>null):null;
  const status=gp?.header?.competitions?.[0]?.status?.type;
  const final=ev.state==='post'&&(gp?._seedFinal===true||status?.completed===true||status?.state==='post');
  games[key]={state:ev.state,detail:ev.detail,kickoff:ev.kickoff,away:ev.away,home:ev.home,away_score:ev.away_score,home_score:ev.home_score,updated_at:gp?.source_updated_at||ev.source_updated_at||null,stats_available:!!gp};
  for(const row of rows.filter(r=>r.game_key===key)) {
   const legs=row.legs.map(l=>({...l,...(l.result?{}:legProgress(l,gp,final,ev))}));
   // Only persist final grades. Live progress rides in the current response.
   if(legs.some((l,i)=>l.result!==row.legs[i].result))await sql(env)`UPDATE parlay_slips SET legs=${JSON.stringify(legs)}::jsonb,version=version+1,updated_at=NOW() WHERE id=${row.id} AND version=${row.version}`;
   games[key].progress={...(games[key].progress||{}),[row.id]:legs};
  }
 }
 return games;
}
