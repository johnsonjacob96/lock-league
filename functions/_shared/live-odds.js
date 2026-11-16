// Live (in-game) chance that a game-line pick hits, read off the books' live
// odds. SharpAPI returns in-play rows (is_live: true) for FanDuel and
// DraftKings, including each book's full alternate ladder, so the price on the
// exact line a member locked is usually posted. Its two sides, with the vig
// removed, are the market's chance that the locked line covers.
//
// Game lines only: a live player-prop pull is many times larger, so prop
// Super Locks get no number here.
import { fetchSharpRaw, canonicalNflTeam, sharpBookKey } from "./odds-providers.js";
import { readSharedFeed, sharedFeed } from "./feed-cache.js";

// One shared pull serves every member: live lines move every play, but a
// minute-old number is plenty for "how is my pick doing".
const TTL_MS = 60 * 1000;
// A book that hasn't repriced a game in this long is suspended or gone.
const BOOK_FRESH_MS = 5 * 60 * 1000;

const implied = (a) => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
const validPrice = (a) => Number.isFinite(a) && Math.abs(a) >= 100 && Math.abs(a) <= 100000;
// The vig-free chance of side A from a two-way pair of American prices.
const twoWay = (a, b) => { const x = implied(a), y = implied(b); return x / (x + y); };

// Live rows -> { "Away@Home": { books: { fanduel: { updated, spread: {home:{line:price}, away:{...}}, total: {over:{...}, under:{...}}, ml: {home, away} } } } }
export function normalizeLiveRows(rows) {
  const games = {};
  const latest = {}; // `${game}|${book}|${market}|${side}|${line}` -> timestamp of the kept price
  for (const r of rows || []) {
    if (r.is_live !== true || r.is_active === false || r.is_player_prop === true) continue;
    const book = sharpBookKey(r.sportsbook);
    const price = Number(r.odds_american);
    if (!book || !validPrice(price)) continue;
    const mt = String(r.market_type || "").toLowerCase();
    const market = mt === "point_spread" ? "spread" : mt === "total_points" ? "total" : mt === "moneyline" ? "ml" : null;
    if (!market) continue;
    const home = canonicalNflTeam(r.home_team), away = canonicalNflTeam(r.away_team);
    if (!home || !away) continue;
    const side = String(r.selection_type || "").toLowerCase();
    if (market === "total" ? !["over", "under"].includes(side) : !["home", "away"].includes(side)) continue;
    const line = market === "ml" ? null : Number(r.line);
    if (market !== "ml" && !Number.isFinite(line)) continue;
    const key = `${away}@${home}`;
    const at = Date.parse(r.timestamp) || 0;
    const id = `${key}|${book}|${market}|${side}|${line}`;
    if (latest[id] != null && latest[id] > at) continue; // keep the newest quote for a line
    latest[id] = at;
    const g = games[key] || (games[key] = { away, home, books: {} });
    const b = g.books[book] || (g.books[book] = { updated: 0, spread: { home: {}, away: {} }, total: { over: {}, under: {} }, ml: {} });
    b.updated = Math.max(b.updated, at);
    if (market === "ml") b.ml[side] = price;
    else b[market][side][line] = price;
  }
  for (const g of Object.values(games))
    for (const b of Object.values(g.books)) b.updated = b.updated ? new Date(b.updated).toISOString() : null;
  return games;
}

// The chance at line L from a ladder of [line, chance] points that rises with
// the line. An exact quote wins; between two quotes, interpolate on the
// log-odds scale (chances bunch up near 0 and 1); past either end of the
// ladder the nearest quote stands, since no book will price further out.
function atLine(points, L) {
  if (!points.length) return null;
  points.sort((a, b) => a[0] - b[0]);
  const hit = points.find(([l]) => l === L);
  if (hit) return hit[1];
  if (L < points[0][0]) return points[0][1];
  if (L > points.at(-1)[0]) return points.at(-1)[1];
  const hi = points.findIndex(([l]) => l > L), [l0, p0] = points[hi - 1], [l1, p1] = points[hi];
  const logit = (p) => Math.log(p / (1 - p)), t = (L - l0) / (l1 - l0);
  return 1 / (1 + Math.exp(-(logit(p0) + t * (logit(p1) - logit(p0)))));
}

// One book's chance for a normalized pick spec, or null when it can't price it.
function bookChance(b, spec) {
  if (spec.market === "ml") {
    const other = spec.side === "home" ? "away" : "home";
    return b.ml[spec.side] != null && b.ml[other] != null ? twoWay(b.ml[spec.side], b.ml[other]) : null;
  }
  const points = [];
  if (spec.market === "spread") {
    // A team at +L against the other side at -L is one two-way market.
    const mine = b.spread[spec.side], theirs = b.spread[spec.side === "home" ? "away" : "home"];
    for (const [l, price] of Object.entries(mine)) {
      const opp = theirs[-Number(l)];
      if (opp != null) points.push([Number(l), twoWay(price, opp)]);
    }
  } else {
    for (const [l, over] of Object.entries(b.total.over)) {
      const under = b.total.under[l];
      if (under != null) points.push([Number(l), twoWay(over, under)]);
    }
  }
  // An over gets likelier as the total drops, so an over ladder rises with the
  // negated line; an under's chance is the rest of the same market.
  if (spec.market === "total") {
    const p = atLine(points.map(([l, q]) => [-l, q]), -spec.line);
    return p == null ? null : spec.side === "over" ? p : 1 - p;
  }
  return atLine(points, spec.line);
}

// What a saved pick is, in live-market terms: { market, side, line }, or null
// for a pick this can't price (player props, free-text Super Locks).
export function pickSpec(p, game) {
  let meta = p.prop_meta || p.prop || null;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { return null; } }
  const kind = p.bet_type === "Favorite" || p.bet_type === "Dog" ? "spread"
    : p.bet_type === "Over" || p.bet_type === "Under" ? "total"
    : p.bet_type === "Super Lock" && meta && !meta.market ? meta.kind : null;
  if (kind === "total") {
    const side = p.side || meta?.side, line = Number(p.line ?? meta?.line);
    return ["over", "under"].includes(side) && Number.isFinite(line) ? { market: "total", side, line } : null;
  }
  if (kind === "moneyline") {
    const side = p.side || meta?.side;
    return ["home", "away"].includes(side) ? { market: "ml", side } : null;
  }
  if (kind === "spread") {
    // The text leads with the picked team and its own line ("Jaguars +3").
    const m = String(p.pick_text || "").match(/^(.+?)\s+([-+]?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const team = canonicalNflTeam(m[1].trim());
    const side = team === game.home ? "home" : team === game.away ? "away" : null;
    return side ? { market: "spread", side, line: Number(m[2]) } : null;
  }
  return null;
}

// Chance a pick hits from a live game's books: the average of every fresh
// book that prices it. null when no book does.
export function liveHitChance(p, game, now = Date.now()) {
  if (!game) return null;
  const spec = pickSpec(p, game);
  if (!spec) return null;
  const used = [], chances = [];
  for (const [book, b] of Object.entries(game.books)) {
    if (!b.updated || now - Date.parse(b.updated) > BOOK_FRESH_MS) continue;
    const c = bookChance(b, spec);
    if (c != null && Number.isFinite(c)) { chances.push(c); used.push(book); }
  }
  if (!chances.length) return null;
  const chance = chances.reduce((s, c) => s + c, 0) / chances.length;
  return { chance: Math.round(chance * 1000) / 1000, books: used };
}

// The live board for the games members have picks in. Pulled only while a
// picked game is in progress; scoped to those games' SharpAPI event IDs when
// the week's catalog has them, so a full Sunday slate stays a page or two.
export async function liveGameOdds(env, season, week, gameKeys) {
  if (!gameKeys.length || !env?.SHARPAPI_KEY) return null;
  const key = `sharp-live-v1:${season}:${week}`;
  return sharedFeed(env, key, TTL_MS, async () => {
    const catalog = await readSharedFeed(env, `sharp-catalog-v3:${season}:${week}`, 7 * 86400 * 1000).catch(() => null);
    const wanted = new Set(gameKeys);
    const ids = [...new Set((catalog?.rows || [])
      .filter((r) => wanted.has(`${canonicalNflTeam(r.away_team)}@${canonicalNflTeam(r.home_team)}`))
      .map((r) => String(r.event_id || "")).filter((id) => /^[A-Za-z0-9_-]+$/.test(id)))];
    const LIVE = { is_live: "true" };
    // If the catalog's IDs miss (none saved, or the books re-keyed a game),
    // the scoped pull comes back empty: take the whole live board instead.
    let rows = ids.length ? await fetchSharpRaw(env, 6, { ...LIVE, event_id: ids.join(",") }, "board") : [];
    if (!rows.length) rows = await fetchSharpRaw(env, 6, LIVE, "board");
    return { fetched_at: new Date().toISOString(), games: normalizeLiveRows(rows), truncated: rows.stats?.truncated || null };
  });
}
