// Shared weekly W/L/P computation for anything that crowns a winner (payout
// ledger, Web Push, Discord/GroupMe). Mirrors the client's mergeLiveSeason
// injection in index.html: once a week has locked, any bet type a member
// never filled counts as an automatic loss, so every server-side winner
// computation agrees with the standings the site actually shows.
import { BET_TYPES } from "./nfl.js";

// memberIds: every member who should be scored (the full roster, not just
// those with a pick row, so a member who skipped the week entirely still
// gets charged the missing-slot losses once locked).
// picks: ALL of that week's picks (not filtered by result), each
// {member_id, bet_type, result}. A null result is a submitted-but-ungraded
// pick (e.g. an unmarked free-text Super Lock) and is tracked as `pending`,
// distinct from a slot the member never filled at all.
export function weeklyMemberRecords(memberIds, picks, { locked }) {
  const byId = new Map();
  for (const id of memberIds) byId.set(id, { W: 0, L: 0, P: 0, pending: 0, filled: new Set() });
  for (const p of picks) {
    const rec = byId.get(p.member_id);
    if (!rec) continue;
    rec.filled.add(p.bet_type);
    if (p.result === "W" || p.result === "L" || p.result === "P") rec[p.result]++;
    else rec.pending++;
  }
  if (locked) {
    for (const rec of byId.values()) {
      const missing = BET_TYPES.length - rec.filled.size;
      if (missing > 0) rec.L += missing;
    }
  }
  for (const rec of byId.values()) delete rec.filled;
  return byId;
}

// Unique best W (fewest L breaks ties); ties leave the week with no winner.
export function weeklyWinner(records) {
  let best = null, tied = false;
  for (const [member_id, r] of records) {
    if (!(r.W || r.L || r.P || r.pending)) continue; // no activity this week
    if (!best || r.W > best.r.W || (r.W === best.r.W && r.L < best.r.L)) { best = { member_id, r }; tied = false; }
    else if (r.W === best.r.W && r.L === best.r.L) tied = true;
  }
  if (!best || tied || best.r.W <= 0) return null;
  return { member_id: best.member_id, w: best.r.W, l: best.r.L };
}
