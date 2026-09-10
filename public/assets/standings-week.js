// Read-only weekly standings. All pick visibility comes from /api/warroom.
let standingsWeekTimer = null;
function standingsWeekActive() {
  return state.view === 'standings' && !!DATA?.seasons?.[state.season]?.live && state.standingsMode === 'week';
}
function standingsWeekMember() {
  const members = state.warRoom?.members || [];
  return members.find(m => String(m.member_id) === String(state.standingsMemberId)) || members.find(m => isMe(m.name)) || members[0];
}
function standingsWeekRows(members) {
  // Settled W/L only, including the existing missed-pick losses. No projections.
  const rows = members.slice().sort((a,b) => (b.live.fW || 0)-(a.live.fW || 0) || (a.live.fL || 0)-(b.live.fL || 0) || a.name.localeCompare(b.name));
  let rank = 1;
  return rows.map((m,i) => {
    const prev = rows[i-1];
    if (!prev || (prev.live.fW || 0) !== (m.live.fW || 0) || (prev.live.fL || 0) !== (m.live.fL || 0)) rank = i+1;
    return {m,rank};
  });
}
function standingsSlip(p) {
  const category = `<span class="week-slip-category">${btShort(p.bet_type)}</span>`;
  if (p.kind !== 'pick') return `<article class="week-slip">${category}<div class="week-slip-body"><strong>${p.kind === 'missing' ? 'No pick submitted' : 'Reveals at lock'}</strong></div><span class="week-slip-status ${p.kind === 'missing' ? 'miss' : ''}">${p.kind === 'missing' ? 'MISS' : 'HIDDEN'}</span></article>`;
  const result = p.final ? {win:'HIT',lose:'MISS',push:'PUSH'}[p.status] : null;
  const label = result || (p.state === 'in' && !p.final ? 'LIVE' : 'PENDING');
  const cached = wrGameCache[p.game_key]?.data;
  const score = p.score;
  const game = score ? {away:{name:score.away,score:score.away_score},home:{name:score.home,score:score.home_score}} : null;
  const photo = p.prop?.player ? slPlayerPhoto(p.prop.player) : null;
  const portrait = photo ? `<img class="week-player-photo" src="${escapeHtml(photo)}" alt="" width="44" height="44" loading="lazy" onerror="this.hidden=true">` : '';
  const logos = !p.prop && score ? `<span class="week-team-logos">${teamLogoMark(score.away,'w-7 h-7','quiet-copy')}${teamLogoMark(score.home,'w-7 h-7','quiet-copy')}</span>` : '';
  const clock = score ? `${teamShort(score.away)} ${score.away_score ?? '–'} · ${teamShort(score.home)} ${score.home_score ?? '–'} · ${p.detail || (p.final ? 'Final' : 'Awaiting grade')}` : p.kickoff ? `${fmtKickoffDay(p.kickoff)} · ${fmtKickoffTime(p.kickoff)}` : p.detail || '';
  const stats = p.prop?.market && !result ? (cached?.found ? wrPropTrack(p,cached) : cached ? 'Player stats unavailable' : 'Player stats loading…') : '';
  return `<article class="week-slip">${category}<div class="week-slip-body"><div class="week-slip-pick">${portrait}${logos}<strong>${escapeHtml(p.pick_text)}</strong></div><small>${escapeHtml(bookLabel(p.book))}${p.price != null ? ' · '+americanOdds(p.price) : ''}</small>${stats ? `<p class="quiet-copy">${escapeHtml(stats)}</p>` : ''}${!result ? liveProgressBar(p,cached?.found ? cached : game) : ''}${clock ? `<p class="week-slip-clock">${escapeHtml(clock)}</p>` : ''}${p.prop?.market && cached?.found && !result ? `<small>${escapeHtml(sourceAgeLabel(cached.stats_updated_at,cached.stale))}</small>` : ''}</div><span class="week-slip-status ${label.toLowerCase()}">${label}</span></article>`;
}
function standingsWeekCard(member, mobile = false) {
  if (!member) return '';
  return `<section class="week-member-card" aria-label="${escapeHtml(member.name)}’s weekly card"><div class="week-card-heading"><h3>${escapeHtml(member.name)}’s card ${isMe(member.name) ? '<span class="week-you">YOU</span>' : ''}</h3><p>Week ${state.warRoom.week} · ${member.live.fW || 0}–${member.live.fL || 0}${member.live.fP ? '–'+member.live.fP : ''} settled</p>${mobile ? '<button class="text-action" data-close-week-card aria-label="Close weekly card">Close ↑</button>' : ''}</div>${BET_TYPES_ORDER.map(bt => standingsSlip(member.picks.find(p => p.bet_type === bt) || {bet_type:bt,kind:'hidden'})).join('')}</section>`;
}
function renderStandingsWeek() {
  const wr = state.warRoom;
  if (!state.user || wr?.needLogin) return '<div class="compact-panel"><p>Sign in to view this week’s cards.</p><button class="text-action" data-account>Sign in →</button></div>';
  if (!wr || (wr.season && String(wr.season) !== state.season)) return '<p class="quiet-copy" role="status">Loading this week’s cards…</p>';
  if (wr.error) return '<p class="quiet-copy" role="status">This week’s cards are temporarily unavailable. Retrying automatically.</p>';
  if (!wr.members?.length) return '<p class="quiet-copy">Cards reveal as games start. Check back at kickoff.</p>';
  const selected = standingsWeekMember();
  return `${wr.stale ? '<p class="quiet-copy" role="status">Updates delayed · Showing the last available cards.</p>' : ''}<div class="standings-week-layout"><div class="week-league"><div class="week-league-heading"><h3>This week <span>Week ${wr.week}</span></h3><p>Settled W–L · Ties share rank</p></div><div class="week-league-labels" aria-hidden="true"><span>#</span><span>Member</span><span>W–L–P</span></div>${standingsWeekRows(wr.members).map(({m,rank}) => {
    const chosen = m === selected;
    const live = m.picks.filter(p => p.kind === 'pick' && p.state === 'in' && !p.final).length;
    const hidden = m.picks.filter(p => p.kind === 'hidden').length;
    const pending = m.picks.filter(p => p.kind === 'pick' && !p.final && p.state !== 'in').length;
    const summary = [`${m.live.fW || 0} hit`, `${m.live.fL || 0} missed`, live ? `${live} live` : '', pending ? `${pending} pending` : '', hidden ? `${hidden} hidden` : ''].filter(Boolean).join(' · ');
    return `<button class="week-member-row ${chosen ? 'selected' : ''} ${isMe(m.name) ? 'is-you' : ''}" data-week-member="${m.member_id}" aria-label="View ${escapeHtml(m.name)}’s weekly picks" aria-pressed="${chosen}"><span class="week-rank">${rank}</span><span class="week-member-name">${escapeHtml(m.name)} ${isMe(m.name) ? '<span class="week-you">YOU</span>' : ''}<small>${summary}</small></span><span class="week-record">${m.live.fW || 0}–${m.live.fL || 0}${m.live.fP ? '–'+m.live.fP : ''}</span></button>${chosen && state.standingsCardOpen ? `<div class="week-mobile-card">${standingsWeekCard(m,true)}</div>` : ''}`;
  }).join('')}<p class="week-hint">Select a member to view their revealed picks.</p></div><aside class="week-desktop-card">${standingsWeekCard(selected)}</aside></div>`;
}
function bindStandingsWeek() {
  document.querySelectorAll('[data-week-member]').forEach(button => {
    button.onclick = () => {
      const same = String(standingsWeekMember()?.member_id) === button.dataset.weekMember;
      state.standingsMemberId = button.dataset.weekMember;
      state.standingsCardOpen = same ? !state.standingsCardOpen : true;
      updateStandingsWeek();
      refreshStandingsWeekStats();
    };
  });
  document.querySelectorAll('[data-close-week-card]').forEach(button => button.onclick = () => {
    state.standingsCardOpen = false;
    updateStandingsWeek();
    document.querySelector(`[data-week-member="${state.standingsMemberId || standingsWeekMember()?.member_id}"]`)?.focus({preventScroll:true});
  });
}
function updateStandingsWeek() {
  const mount = document.getElementById('standings-week');
  if (!standingsWeekActive() || !mount) return;
  const focused = document.activeElement?.dataset.weekMember;
  const html = renderStandingsWeek();
  if (mount._lastHtml === html) return;
  mount.innerHTML = html;
  mount._lastHtml = html;
  bindStandingsWeek();
  if (focused) mount.querySelector(`[data-week-member="${focused}"]`)?.focus({preventScroll:true});
}
function refreshStandingsWeekStats() {
  if (!standingsWeekActive()) return;
  const keys = new Set((standingsWeekMember()?.picks || []).filter(p => p.kind === 'pick' && p.prop?.market && !p.final && p.game_key).map(p => p.game_key));
  for (const key of keys) loadWrGame(key);
}
async function refreshStandingsWeek() {
  await loadWarRoom();
  if (!standingsWeekActive()) return;
  updateStandingsWeek();
  refreshStandingsWeekStats();
  await loadSlPlayerPhotos();
  updateStandingsWeek();
}
function startStandingsWeekPoll() {
  clearInterval(standingsWeekTimer);
  standingsWeekTimer = setInterval(() => {
    if (!standingsWeekActive()) { clearInterval(standingsWeekTimer); standingsWeekTimer = null; return; }
    if (!document.hidden) refreshStandingsWeek();
  },45000);
}
