// /api/notify — cron-only push triggers.
//   ?type=reminder  -> Web Push to members with fewer than 5 picks for the
//                      current week, before the Sunday-noon-CT lock.
// Auth: X-Cron-Secret header must match env.CRON_SECRET.
import { sql } from "../_shared/db.js";
import { currentNflWeek, pickCutoff } from "../_shared/nfl.js";
import { pushPersonalized, ensurePushTables, claimSend } from "../_shared/push-notify.js";
import { pushWeekResults, sameTeam } from "../_shared/grader.js";
import { ensureExtras } from "../_shared/migrations.js";
import { makeVapidJwt, encryptPayload } from "../_shared/webpush.js";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// ── Line-move alert helpers ──────────────────────────────────────────────────
const MOVE_THRESHOLD = 0.5; // half a point in the picker's favor before we ping
const bookLabel = (k) => ({ fanduel: "FanDuel", draftkings: "DraftKings", espn: "ESPN" })[k] || (k ? String(k).toUpperCase() : "");
const nick = (s) => String(s || "").split(" ").pop();

async function fetchBoard(request) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(new URL("/api/odds", request.url), { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.games) ? j.games : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function findGame(games, key) {
  if (!key) return null;
  const [a, h] = String(key).split("@");
  return games.find((g) => sameTeam(g.away, a) && sameTeam(g.home, h)) || null;
}
// Picker value of a line: higher is always better for whoever holds this side.
function perspVal(side, line) {
  const n = Number(line);
  if (!Number.isFinite(n)) return null;
  if (side === "fav") return n;        // -2.5 beats -4 (fewer points to give)
  if (side === "dog") return -n;       // more negative fav line = more dog points
  if (side === "over") return -n;      // lower total = easier over
  if (side === "under") return n;      // higher total = easier under
  return null;
}
// Best current number for a side across every book on the board.
function bestCurrentLine(game, side) {
  let best = null;
  for (const [book, b] of Object.entries(game.books || {})) {
    let line = null;
    if ((side === "fav" || side === "dog") && b.spread?.line != null) line = Number(b.spread.line);
    else if ((side === "over" || side === "under") && b.total?.point != null) line = Number(b.total.point);
    if (line == null) continue;
    const v = perspVal(side, line);
    if (best == null || v > best.v) best = { line, book, v };
  }
  return best;
}
function fmtLineForSide(side, line) {
  const n = Number(line);
  if (!Number.isFinite(n)) return "";
  return side === "dog" ? `+${Math.abs(n)}` : `${n}`;
}
function sideHint(game, side) {
  if (side === "over" || side === "under") return `${nick(game.away)}/${nick(game.home)}`;
  const sp = Object.values(game.books || {}).map((b) => b.spread).find(Boolean);
  if (!sp) return "";
  const other = sp.fav === game.home ? game.away : game.home;
  return nick(side === "fav" ? sp.fav : other);
}

async function recipientPreview(env, ids, kind) {
  if (!ids.length) return [];
  const rows = await sql(env)`SELECT m.id, m.name, m.notif_prefs, COUNT(s.id)::int AS devices
    FROM members m LEFT JOIN push_subscriptions s ON s.member_id = m.id
    WHERE m.id = ANY(${ids}) GROUP BY m.id, m.name, m.notif_prefs`;
  return rows.filter(r => r.devices > 0 && r.notif_prefs?.[kind] !== false);
}

// Checks cryptographic configuration locally. It never contacts a push service
// and returns only booleans/counts, never endpoints, keys, or signed tokens.
async function pushHealth(env) {
  let keyPairValid = false;
  try {
    const endpoint = "https://push.example.invalid/check";
    const jwt = await makeVapidJwt(endpoint, env.VAPID_SUBJECT || "mailto:johnsonjacob96@gmail.com", env.VAPID_PUBLIC, env.VAPID_PRIVATE);
    const bytes = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", bytes(env.VAPID_PUBLIC), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const [header, payload, signature] = jwt.split(".");
    keyPairValid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      bytes(signature), new TextEncoder().encode(`${header}.${payload}`));
  } catch { /* invalid or missing pair */ }
  const rows = await sql(env)`SELECT s.member_id, s.p256dh, s.auth, m.notif_prefs
    FROM push_subscriptions s JOIN members m ON m.id = s.member_id`;
  let validSubscriptionKeys = 0;
  for (const row of rows) {
    try { await encryptPayload("local health verification", row.p256dh, row.auth); validSubscriptionKeys++; }
    catch { /* malformed stored key */ }
  }
  const subjectValid = /^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT || "mailto:johnsonjacob96@gmail.com");
  return { ok: keyPairValid && subjectValid && validSubscriptionKeys === rows.length, dryrun: true,
    vapidConfigured: !!env.VAPID_PUBLIC && !!env.VAPID_PRIVATE, keyPairValid,
    subjectValid,
    subscribedMembers: new Set(rows.map(r => r.member_id)).size, subscriptions: rows.length,
    validSubscriptionKeys, invalidSubscriptionKeys: rows.length - validSubscriptionKeys,
    enabledMembers: Object.fromEntries(["reminder", "lineMoves", "results"].map(kind => [kind,
      new Set(rows.filter(r => r.notif_prefs?.[kind] !== false).map(r => r.member_id)).size])) };
}

export async function onRequest({ request, env }) {
  const secret = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "reminder";
  const dryrun = url.searchParams.get("dryrun") === "1";
  if (type === "health") {
    if (!dryrun) return json({ error: "dryrun-required" }, { status: 400 });
    return json(await pushHealth(env), { headers: { "Cache-Control": "no-store" } });
  }
  const cur = currentNflWeek(new Date(), env);
  if (!cur.week) return json({ ok: true, note: cur.status });

  if (type === "reminder") {
    const cutoff = pickCutoff(cur.season, cur.week, env);
    // ?dryrun=1 computes recipients but sends nothing — used to verify the
    // (Cloudflare-cron) automated path fires on schedule without buzzing phones.
    // Fire only inside the ~1-hour-before-lock window. Cron is fixed-UTC and can't
    // follow DST, but the noon-CT lock shifts (17:00 UTC in CDT, 18:00 in CST). So
    // the scheduler fires BOTH 16:00 and 17:00 UTC every Sunday and this window
    // admits exactly the one that's ~1h out — 16:00 during CDT (11am CDT), 17:00
    // during CST (11am CST) — while the off-week fire lands ~2h out and no-ops.
    // Also blocks firing weeks early if a week has no live cutoff yet.
    // ?force=1 (or dryrun) bypasses the window (manual testing / ad-hoc re-fire).
    if (!dryrun && url.searchParams.get("force") !== "1") {
      const minsToLock = (cutoff.getTime() - Date.now()) / 60000;
      if (!(minsToLock > 0 && minsToLock <= 75)) {
        return json({ ok: true, note: "outside reminder window", minsToLock: Math.round(minsToLock) });
      }
    }
    const rows = await sql(env)`
      SELECT m.id, m.name, COUNT(p.id)::int AS picks
      FROM members m
      LEFT JOIN picks p ON p.member_id = m.id AND p.season = ${cur.season} AND p.week = ${cur.week}
      GROUP BY m.id, m.name`;
    const behind = rows.filter((r) => r.picks < 5);
    if (!behind.length) return json({ ok: true, note: "everyone submitted" });

    const timeStr = cutoff.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
    });
    // Weekday of the lock, derived from the cutoff (Central), so the copy is
    // correct whenever the deadline isn't a Sunday — e.g. the preseason test
    // locks on Thursday. Reverts to "Sunday" automatically in the regular season.
    const dayStr = cutoff.toLocaleDateString("en-US", {
      weekday: "long", timeZone: "America/Chicago",
    });
    const byMemberId = {};
    for (const r of behind) {
      const left = 5 - r.picks;
      byMemberId[r.id] = {
        title: `Week ${cur.week}: ${left} pick${left === 1 ? "" : "s"} to go`,
        body: r.picks === 0
          ? `You have not locked any picks yet. Lock closes at ${timeStr} CT ${dayStr}.`
          : `You are ${r.picks} of 5 in. ${left} left before ${timeStr} CT ${dayStr}.`,
        url: "/",
        tag: `ll-reminder-${cur.season}-${cur.week}`,
      };
    }
    if (dryrun) {
      const recipients = await recipientPreview(env, behind.map(b => b.id), "reminder");
      return json({ ok: true, dryrun: true, week: cur.week, wouldRemind: recipients.map(r => r.name),
        devices: recipients.reduce((n, r) => n + r.devices, 0), missingPicks: behind.map(b => b.name) });
    }
    const res = await pushPersonalized(env, byMemberId, "reminder");
    return json({ ok: true, week: cur.week, reminded: behind.map((b) => b.name), ...res });
  }

  if (type === "kickoff-reminder") {
    const cutoff = pickCutoff(cur.season, cur.week, env);
    if (Date.now() >= cutoff.getTime()) return json({ ok: true, note: "past cutoff" });
    const games = await fetchBoard(request);
    if (!games) return json({ ok: true, note: "odds unavailable" });
    const upcoming = games.filter(game => {
      const kickoff = Date.parse(game.kickoff), minutes = (kickoff - Date.now()) / 60000;
      const monday = new Date(kickoff).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Chicago" }) === "Mon";
      return Number.isFinite(kickoff) && minutes > 0 && minutes <= 120 && kickoff < cutoff.getTime() && !monday;
    });
    if (!upcoming.length) return json({ ok: true, ...(dryrun ? { dryrun: true } : {}), note: "no upcoming kickoff" });
    const rows = await sql(env)`SELECT m.id, m.name, COUNT(p.id)::int AS picks
      FROM members m LEFT JOIN picks p ON p.member_id=m.id AND p.season=${cur.season} AND p.week=${cur.week}
      GROUP BY m.id, m.name`;
    const recipients = await recipientPreview(env, rows.filter(r => r.picks < 5).map(r => r.id), "reminder");
    if (dryrun) return json({ ok: true, dryrun: true, week: cur.week, games: upcoming.length,
      wouldRemind: recipients.map(r => r.name), devices: recipients.reduce((n, r) => n + r.devices, 0) });
    if (!recipients.length) return json({ ok: true, note: "no subscribed members need picks" });
    const results = [];
    for (const game of upcoming) {
      const kind = `kickoff:${game.away}@${game.home}:${game.kickoff}`;
      if (!(await claimSend(env, cur.season, cur.week, kind))) continue;
      const time = new Date(game.kickoff).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
      const byMemberId = Object.fromEntries(recipients.map(r => [r.id, {
        title: `${nick(game.away)} at ${nick(game.home)} tonight`,
        body: `Game picks lock at ${time} CT. Your Week ${cur.week} card still has open slots.`,
        url: "/", tag: `ll-kickoff-${cur.season}-${cur.week}-${game.id || game.home}`,
      }]));
      results.push(await pushPersonalized(env, byMemberId, "reminder"));
    }
    return json({ ok: true, week: cur.week, games: results.length, results });
  }

  if (type === "results") {
    if (dryrun) {
      const picks = await sql(env)`SELECT member_id, result FROM picks WHERE season=${cur.season} AND week=${cur.week}`;
      const recipients = await recipientPreview(env, [...new Set(picks.map(p => p.member_id))], "results");
      return json({ ok: true, dryrun: true, week: cur.week, pending: picks.filter(p => !p.result).length,
        ready: picks.length > 0 && picks.every(p => p.result) && Date.now() >= pickCutoff(cur.season, cur.week, env).getTime(),
        eligibleMembers: recipients.length, devices: recipients.reduce((n, r) => n + r.devices, 0) });
    }
    // On-demand winner/results push. Grading fires this automatically once every
    // game is final; this lets a test (or a re-run) trigger it directly.
    // ?reset=1 clears the once-per-week guard so it can be re-fired.
    if (url.searchParams.get("reset") === "1") {
      await ensurePushTables(env);
      await sql(env)`DELETE FROM week_notifications
        WHERE season = ${cur.season} AND week = ${cur.week} AND kind = 'winner'`;
    }
    const res = await pushWeekResults(env, cur.season, cur.week);
    return json({ ok: true, week: cur.week, ...res });
  }

  if (type === "line-moves") {
    // Ping members whose locked pick now has a better number on either book, so
    // they can re-lock before the Sunday cutoff. Skips once picks are locked.
    const cutoff = pickCutoff(cur.season, cur.week, env);
    if (Date.now() >= cutoff.getTime()) return json({ ok: true, note: "past cutoff, picks locked" });
    if (!dryrun) await ensureExtras(env);
    const games = await fetchBoard(request);
    if (!games) return json({ ok: true, note: "odds unavailable" });

    const rows = await sql(env)`
      SELECT p.id, p.member_id, m.name, p.bet_type, p.game_key, p.side, p.line, p.alert_line
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${cur.season} AND p.week = ${cur.week}
        AND p.bet_type IN ('Favorite','Dog','Over','Under')
        AND p.game_key IS NOT NULL AND p.line IS NOT NULL`;

    const byMember = {}; // memberId -> [{ bet, hint, lockedFmt, bestFmt, book }]
    const toMark = [];   // { id, line } — record what we alerted so we don't repeat
    for (const p of rows) {
      const g = findGame(games, p.game_key);
      if (!g || !Number.isFinite(Date.parse(g.kickoff)) || Date.parse(g.kickoff) <= Date.now()) continue;
      const best = bestCurrentLine(g, p.side);
      const lockedV = perspVal(p.side, p.line);
      if (!best || lockedV == null) continue;
      if (best.v - lockedV < MOVE_THRESHOLD) continue;             // not enough better than what you locked
      if (p.alert_line != null) {
        const alertV = perspVal(p.side, p.alert_line);
        if (alertV != null && best.v - alertV < MOVE_THRESHOLD) continue; // already told you about this good a line
      }
      (byMember[p.member_id] ||= []).push({
        bet: p.bet_type,
        hint: sideHint(g, p.side),
        lockedFmt: fmtLineForSide(p.side, p.line),
        bestFmt: fmtLineForSide(p.side, best.line),
        book: bookLabel(best.book),
      });
      toMark.push({ id: p.id, line: best.line });
    }
    if (!toMark.length) return json({ ok: true, week: cur.week, note: "no improvements" });

    const timeStr = cutoff.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
    const byMemberId = {};
    for (const [mid, items] of Object.entries(byMember)) {
      const title = items.length === 1
        ? `Better ${items[0].bet} number available`
        : `${items.length} of your picks have better numbers`;
      const body = items.map((it) => `${it.hint} now ${it.bestFmt} on ${it.book} (you have ${it.lockedFmt})`).join(" · ")
        + `. Re-lock before ${timeStr} CT Sunday.`;
      byMemberId[mid] = { title, body, url: "/", tag: `ll-linemove-${cur.season}-${cur.week}` };
    }
    if (dryrun) {
      const recipients = await recipientPreview(env, Object.keys(byMemberId).map(Number), "lineMoves");
      return json({ ok: true, dryrun: true, week: cur.week, wouldAlert: recipients.map(r => r.name),
        devices: recipients.reduce((n, r) => n + r.devices, 0), picks: toMark.length });
    }
    const res = await pushPersonalized(env, byMemberId, "lineMoves");
    await Promise.all(toMark.map((m) => sql(env)`UPDATE picks SET alert_line = ${m.line} WHERE id = ${m.id}`));
    return json({ ok: true, week: cur.week, alerted: Object.keys(byMemberId).length, picks: toMark.length, ...res });
  }

  return json({ error: "unknown-type" }, { status: 400 });
}
