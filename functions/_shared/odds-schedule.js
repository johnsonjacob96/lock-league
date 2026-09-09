// The schedule owns the game list; a partial odds response owns only its quotes.
export function retainSchedule(payload, events) {
  const map = new Map(
    (payload.games || []).map((g) => [`${g.away}@${g.home}`, g]),
  );
  for (const ev of events || []) {
    const cs = ev.competitions?.[0]?.competitors || [];
    const home = cs.find((c) => c.homeAway === "home")?.team?.displayName;
    const away = cs.find((c) => c.homeAway === "away")?.team?.displayName;
    if (home && away && !map.has(`${away}@${home}`))
      map.set(`${away}@${home}`, {
        id: ev.id,
        home,
        away,
        kickoff: ev.date,
        books: {},
        odds_unavailable: true,
      });
  }
  return {
    ...payload,
    games: [...map.values()].sort(
      (a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff),
    ),
  };
}
