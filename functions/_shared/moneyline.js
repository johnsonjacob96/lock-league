import { NFL_TEAMS } from './nfl-teams.js';

export const validMoneylinePrice = p => Number.isInteger(p) && Math.abs(p) >= 100 && Math.abs(p) <= 1000000;
export const validMoneyline = m => !!m && validMoneylinePrice(m.homePrice) && validMoneylinePrice(m.awayPrice);

// Resolve only an exact team/abbreviation/nickname, never a partial player name
// or a period/team-total bet that happens to contain a team's name.
export function canonicalMoneylineText(text) {
  const match = String(text || '').replace(/\b(?:fanduel|draftkings|fd|dk)\b/gi,'').trim().match(/^(.+?)\s+(?:ML|money\s*line)(?:\s+[+-]\d{3,})?$/i);
  if (!match) return null;
  const key = s => s.toLowerCase().replace(/[^a-z0-9]/g,'');
  const input = key(match[1]);
  const matches = NFL_TEAMS.filter(([abbr,name]) => [abbr,name,name.split(' ').at(-1)].some(n => key(n) === input));
  return matches.length === 1 ? `${matches[0][1]} ML` : null;
}

// Final-score only: leading during a live game is not a settled moneyline win.
export function resolveMoneylineResult(p, ev) {
  if (!ev || !(ev.status === 'final' || ev.state === 'post') ||
      ![ev.home_score,ev.away_score].every(s => Number.isFinite(s) && s >= 0) ||
      !['home','away'].includes(p.side)) return null;
  const picked = p.side === 'home' ? ev.home : ev.away;
  if (canonicalMoneylineText(p.pick_text) !== `${picked} ML`) return null;
  const margin = p.side === 'home' ? ev.home_score-ev.away_score : ev.away_score-ev.home_score;
  return margin === 0 ? 'P' : margin > 0 ? 'W' : 'L';
}

export function resolveMoneylineRows(rows) {
  const latest = side => {
    const candidates = rows.filter(r => r.side === side);
    if (!candidates.length) return null;
    candidates.sort((a,b) => Date.parse(b.updated)-Date.parse(a.updated));
    const best = candidates[0];
    if (candidates.some(r => r.updated === best.updated && r.price !== best.price)) return null;
    return best;
  };
  const home = latest('home'), away = latest('away');
  if (!home || !away || rows.some(r => !['home','away'].includes(r.side))) return null;
  return {homePrice:home.price,awayPrice:away.price,
    updated:new Date(Math.min(Date.parse(home.updated),Date.parse(away.updated))).toISOString()};
}
