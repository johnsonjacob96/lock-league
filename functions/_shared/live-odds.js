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
// Removing the book's margin. Books don't spread it evenly: nearly all of it
// rides on the longshot, so scaling both sides down by the same factor drags a
// heavy favorite toward 50% (Under 49.5 at -2500 / Over +850 read 90%, not
// the ~95% the price means). The power method raises both implied chances to
// one exponent k so they sum to 1, which leaves a favorite nearly whole.
// Returns side A's fair chance and the k that got there.
function devig(a, b) {
  const x = implied(a), y = implied(b);
  if (x + y <= 1) return { p: x / (x + y), k: 1 }; // no margin to remove
  let lo = 1, hi = 50;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (x ** k + y ** k > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return { p: x ** k / (x ** k + y ** k), k };
}
// The exponent a standard -110/-110 market carries, for a book that posts no
// two-sided line to measure its own.
const DEFAULT_K = Math.log(0.5) / Math.log(110 / 210);
const median = (xs) => { const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// A ladder of [line, price for my side, price against] -> [line, fair chance]
// points. Late in a game books often post only one side of a line (FanDuel's
// Under 45.5 at -700 with no over); that quote still says where the market
// is, so it's de-vigged with the margin the same book shows on its two-sided
// lines instead of being dropped.
function ladderPoints(ladder) {
  const pairs = ladder.filter(([, a, b]) => a != null && b != null).map(([l, a, b]) => [l, devig(a, b)]);
  const k = pairs.length ? median(pairs.map(([, d]) => d.k)) : DEFAULT_K;
  // [line, chance, weight]: a two-sided quote is the book's own number and
  // anchors the ladder; a one-sided estimate yields to it.
  const points = pairs.map(([l, d]) => [l, d.p, 1000]);
  for (const [l, a, b] of ladder) {
    if (a != null && b == null) points.push([l, Math.min(1, implied(a) ** k), 1]);
    else if (a == null && b != null) points.push([l, Math.max(0, 1 - implied(b) ** k), 1]);
  }
  // More points can only help my side, so the chance must rise with the line.
  // One-sided estimates can wobble a point out of order; average any run that
  // does, by weight (pool adjacent violators), so a better line never reads
  // worse and a two-sided quote keeps its price.
  points.sort((x, y) => x[0] - y[0]);
  const blocks = [];
  for (const [l, p, w] of points) {
    blocks.push({ lines: [l], sum: p * w, n: w });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).n > blocks.at(-1).sum / blocks.at(-1).n) {
      const top = blocks.pop(), prev = blocks.at(-1);
      prev.lines.push(...top.lines); prev.sum += top.sum; prev.n += top.n;
    }
  }
  return blocks.flatMap((bl) => bl.lines.map((l) => [l, bl.sum / bl.n]));
}

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
    return b.ml[spec.side] != null && b.ml[other] != null ? devig(b.ml[spec.side], b.ml[other]).p : null;
  }
  if (spec.market === "spread") {
    // A team at +L against the other side at -L is one two-way market.
    const mine = b.spread[spec.side], theirs = b.spread[spec.side === "home" ? "away" : "home"];
    const lines = new Set([...Object.keys(mine).map(Number), ...Object.keys(theirs).map((l) => -Number(l))]);
    return atLine(ladderPoints([...lines].map((l) => [l, mine[l] ?? null, theirs[-l] ?? null])), spec.line);
  }
  // Totals: the over's chance per line. An over gets likelier as the total
  // drops, so its ladder rises with the negated line; an under's chance is the
  // rest of the same market.
  const lines = new Set([...Object.keys(b.total.over), ...Object.keys(b.total.under)].map(Number));
  const p = atLine(ladderPoints([...lines].map((l) => [-l, b.total.over[l] ?? null, b.total.under[l] ?? null])), -spec.line);
  return p == null ? null : spec.side === "over" ? p : 1 - p;
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
