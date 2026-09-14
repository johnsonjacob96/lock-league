// Adapter from the existing season archive to the shared Article 7 / 12 rules.
function rulesSeasonPicks(name, season, through=18) {
  const out=[];
  for (const [bet_type,bt] of Object.entries(DATA.members[name]?.[season]?.byType || {}))
    for (const [week,p] of Object.entries(bt.picks || {}))
      if (Number(week)<=through) out.push({...p,bet_type,member_id:name,week:Number(week)});
  return out;
}
function rulesWeeklyDecision(season,week,locked=true,names=DATA.seasons[season]?.members || [],overridePicks=null) {
  let seasonPicks=names.flatMap(name=>rulesSeasonPicks(name,season,week));
  if (overridePicks) {
    const fresh=overridePicks.map(p=>({...p,member_id:p.member_name,week:Number(week)}));
    if(locked)for(const name of names)for(const bet_type of ['Favorite','Dog','Over','Under','Super Lock'])
      if(!fresh.some(p=>p.member_id===name && p.bet_type===bet_type))fresh.push({member_id:name,bet_type,week:Number(week),result:'L',missing:true});
    seasonPicks=seasonPicks.filter(p=>p.week!==Number(week)).concat(fresh);
  }
  const historical={};
  for (const name of names) {
    const r={W:0,L:0};
    for (const [year,md] of Object.entries(DATA.members[name] || {})) {
      if (Number(year)>=Number(season)) continue;
      const rec=parseRecord(md.seasonRecord);r.W+=rec.w;r.L+=rec.l;
    }
    historical[name]=r;
  }
  const entries=LeagueTiebreaks.weeklyEntries(names,seasonPicks.filter(p=>p.week===Number(week)),{locked,seasonPicks,historical});
  return LeagueTiebreaks.weeklyDecision(entries.map(e=>({...e,name:e.id})),locked);
}
function rulesRankSeason(rows,season,through=18) {
  const entries=rows.map(r=>({id:r.name,name:r.name,...LeagueTiebreaks.seasonMetrics(rulesSeasonPicks(r.name,season,through))}));
  return LeagueTiebreaks.rankEntries(entries,LeagueTiebreaks.SEASON_CRITERIA).map(e=>({
    ...rows.find(r=>r.name===e.name),rank:e.rank,tied:e.tied,tiebreak:e.tiebreak,
  }));
}
