import { historicalRecords } from './historical-records.js';
import { pickCutoff } from './nfl.js';
import { weeklyEntries, weeklyDecision } from './tiebreaks.js';

export function weeklyContext(picks, members, season, week, env) {
  const eligible = picks.filter(p => Number(p.week)<=Number(week));
  const contested = [...new Set(eligible.map(p=>Number(p.week)))];
  const seasonPicks = eligible.slice();
  for (const wk of contested) {
    if (Date.now()<pickCutoff(season,wk,env).getTime()) continue;
    for (const m of members) for (const bt of ['Favorite','Dog','Over','Under','Super Lock']) {
      if (!eligible.some(p=>p.member_id===m.id && Number(p.week)===wk && p.bet_type===bt))
        seasonPicks.push({member_id:m.id,week:wk,bet_type:bt,result:'L',missing:true});
    }
  }
  const historical={};
  for (const m of members) {
    const r={W:0,L:0};
    for (const [year,data] of Object.entries(historicalRecords[m.name] || {})) {
      if (Number(year)>=Number(season)) continue;
      r.W+=data.W; r.L+=data.L;
    }
    historical[m.id]=r;
  }
  const locked=Date.now()>=pickCutoff(season,week,env).getTime();
  const entries=weeklyEntries(members.map(m=>m.id),eligible.filter(p=>Number(p.week)===Number(week)),{locked,seasonPicks,historical});
  const weekContested=eligible.some(p=>Number(p.week)===Number(week));
  return weeklyDecision(entries.map(e=>({...e,name:members.find(m=>m.id===e.id)?.name})),locked && weekContested);
}
