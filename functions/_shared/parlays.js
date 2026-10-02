import { sql, ignoringConcurrentCreate } from './db.js';
import { PROP_DEFS, playerStatMap } from './props.js';
import { espnSummary } from './espn.js';
import { NFL_TEAMS } from './nfl-teams.js';
let ready=false;
const TEAM_ABBR=new Map(NFL_TEAMS.map(([abbr,team])=>[team,abbr]));
// Resolves a team leg (spread or moneyline) against the two teams in the slip's
// game. Sportsbooks print the same team several ways: FanDuel spells it out
// ("Cleveland Browns"), DraftKings prefixes the abbreviation ("CLE Browns",
// "LA Rams"). Only one of the game's two teams may match.
export function parlaySpreadTeam(input, gameKey) {
 const key=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 const matches=String(gameKey||'').split('@').filter(team=>{
  const words=team.trim().split(/\s+/),nickname=words.at(-1),city=words.slice(0,-1).map(w=>w[0]).join(''),abbr=TEAM_ABBR.get(team.trim());
  return [team,nickname,city+' '+nickname,city+nickname[0],...(abbr?[abbr,abbr+' '+nickname]:[])].some(alias=>key(alias)===key(input));
 });
 return matches.length===1?matches[0]:null;
}
// Spread and moneyline legs both name a team rather than a player.
const TEAM_MARKETS=['spread','moneyline'];
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
  if(!PROP_DEFS[l.market]&&!['manual','game_total','spread','moneyline'].includes(l.market))throw Error('Choose a supported market or Custom.');
  if(!['over','under','atleast','yes','spread','moneyline'].includes(l.side))throw Error('Choose a valid direction.');
  if(l.market==='spread'&&(l.side!=='spread'||!parlaySpreadTeam(l.player,body.game_key)))throw Error('Choose a team in the selected game for each spread.');
  if(l.market!=='spread'&&l.side==='spread')throw Error('Spread direction requires a team spread.');
  if(l.market==='moneyline'&&(l.side!=='moneyline'||!parlaySpreadTeam(l.player,body.game_key)))throw Error('Choose a team in the selected game for each moneyline.');
  if(l.market!=='moneyline'&&l.side==='moneyline')throw Error('Moneyline direction requires a team moneyline.');
  if(l.market==='game_total'&&!['over','under'].includes(l.side))throw Error('Game totals use Over or Under.');
  if(l.market==='anytime_td'&&l.side!=='yes')throw Error('Anytime TD uses Yes.');
  if(!['anytime_td','manual','moneyline'].includes(l.market)&&(!Number.isFinite(l.line)||l.line<(l.market==='spread'?-2000:0)||l.line>2000||l.side==='yes'))throw Error('Enter a valid threshold.');
  if(l.member_id!=null&&!memberIds.includes(l.member_id))throw Error('Choose a league member for each assigned leg.');
  return {player:l.market==='game_total'?'Game total':TEAM_MARKETS.includes(l.market)?parlaySpreadTeam(l.player,body.game_key):l.player.trim(),market:l.market,side:l.side,line:['anytime_td','manual','moneyline'].includes(l.market)?null:l.line,member_id:l.member_id??null,result:null};
 });
 if(body.image!=null&&(typeof body.image!=='string'||body.image.length>1500000||!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(body.image)))throw Error('Upload a JPEG slip smaller than 1 MB.');
 return {...body,title:body.title.trim(),legs};
}
export function legProgress(leg, summary, final=false, game=null) {
 if(leg.manual)return {result:leg.result,actual:leg.actual??null};
 if(TEAM_MARKETS.includes(leg.market)) {
  // A moneyline is a spread of zero: the team wins outright. A tie pushes,
  // as the two-way NFL moneyline does at both books.
  const line=leg.market==='moneyline'?0:leg.line;
  if(!game||!['in','post'].includes(game.state)||![game.away_score,game.home_score].every(v=>Number.isFinite(v)&&v>=0)||!Number.isFinite(line))return {result:null,actual:null};
  const team=parlaySpreadTeam(leg.player,`${game.away}@${game.home}`);
  if(!team)return {result:null,actual:null};
  const actual=team===game.home?game.home_score-game.away_score:game.away_score-game.home_score,adjusted=actual+line;
  return {actual,result:game.state!=='post'?null:adjusted===0?'P':adjusted>0?'W':'L'};
 }
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
