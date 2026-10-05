// A final summary can omit a participant with no counting stats. Resolve the
// game roster and explicit per-game statistics; never infer zero from absence.
import { ESPN_HEADERS } from './espn.js';
import { normPlayer } from './props.js';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
export async function missingPlayerStats(eventId, playerName, boxscore) {
  if (!/^\d+$/.test(String(eventId))) return null;
  const name = normPlayer(playerName);
  if (!name || !name.includes(' ')) return null;
  const teams = [...new Set((boxscore?.players || []).map(t=>String(t.team?.id || '')).filter(id=>/^\d+$/.test(id)))];
  if (teams.length !== 2) return null; // incomplete summary
  const deadline = Date.now()+5000;
  const get = async path => {
    const remaining = deadline-Date.now();
    if (remaining<=0) return null;
    try {
      const r=await fetch(CORE+path,{headers:ESPN_HEADERS,signal:AbortSignal.timeout(Math.min(remaining,1500))});
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const rosters=await Promise.all(teams.map(id=>get(`/events/${eventId}/competitions/${eventId}/competitors/${id}/roster?limit=100`)));
  if (rosters.some(r=>!Array.isArray(r?.entries))) return null;
  const candidates=rosters.flatMap((r,i)=>r.entries.filter(e=>{
    const n=normPlayer(e.displayName);
    return n===name || n===name.split(' ').at(-1);
  }).map(e=>({...e,teamId:teams[i]})));
  if (!candidates.length || candidates.length>2) return null;
  const matches=[];
  for (const e of candidates) {
    if (!/^\d+$/.test(String(e.playerId))) return null;
    const athlete=await get(`/athletes/${e.playerId}`);
    if (!athlete) return null; // do not resolve an ambiguous name from partial data
    if (String(athlete.id)===String(e.playerId) && normPlayer(athlete.displayName)===name) matches.push(e);
  }
  if (matches.length!==1 || matches[0].didNotPlay!==false) return null;
  const e=matches[0];
  const stats=await get(`/events/${eventId}/competitions/${eventId}/competitors/${e.teamId}/roster/${e.playerId}/statistics/0`);
  if (stats?.splits?.name!=='game' || !Array.isArray(stats.splits.categories)) return null;
  const map={};
  for(const cat of stats.splits.categories) for(const stat of cat.stats || []) {
    if(typeof stat.value!=='number' || !Number.isFinite(stat.value)) continue;
    if(Object.hasOwn(map,stat.name) && map[stat.name]!==stat.value) return null;
    map[stat.name]=stat.value;
  }
  return Object.keys(map).length ? map : null;
}
