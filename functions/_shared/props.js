// Player-prop support for the structured Super Lock.
//
// Two responsibilities, both provider-agnostic:
//   1. Normalize a book's player-prop lines into a small, structured menu the
//      picker can render (normalizeSharpProps).
//   2. Grade a locked structured prop against an ESPN box score after the game
//      (gradeProp) — this is what makes the Super Lock auto-grade.
//
// The Super Lock stays free-text-capable: anything with no `prop_meta` grades
// manually as before. Only structured props (picked off the live board) run
// through here.

// ── Canonical prop menu ──────────────────────────────────────────────────────
// Our internal market keys. `stat` is the ESPN box-score stat we grade against
// (or a combine of several); `kind` is how the pick reads: 'ou' = over/under a
// number, 'yes' = a yes/no outcome (anytime TD). `match` are keywords used to
// map a book's own market name onto ours, so we don't hard-depend on the exact
// string a provider uses (e.g. "player_rush_yds" vs "rushing_yards").
export const PROP_DEFS = {
  pass_yds:     { label: "Passing Yards",    unit: "pass yds", kind: "ou",  stat: ["passingYards"] },
  pass_tds:     { label: "Passing TDs",      unit: "pass TDs", kind: "ou",  stat: ["passingTouchdowns"] },
  pass_cmp:     { label: "Completions",      unit: "cmp",      kind: "ou",  stat: ["completions"] },
  pass_att:     { label: "Pass Attempts",    unit: "att",      kind: "ou",  stat: ["passingAttempts"] },
  pass_int:     { label: "Interceptions",    unit: "INT",      kind: "ou",  stat: ["interceptions"] },
  rush_yds:     { label: "Rushing Yards",    unit: "rush yds", kind: "ou",  stat: ["rushingYards"] },
  rush_att:     { label: "Rush Attempts",    unit: "carries",  kind: "ou",  stat: ["rushingAttempts"] },
  rush_tds:     { label: "Rushing TDs",      unit: "rush TDs", kind: "ou",  stat: ["rushingTouchdowns"] },
  rec_yds:      { label: "Receiving Yards",  unit: "rec yds",  kind: "ou",  stat: ["receivingYards"] },
  receptions:   { label: "Receptions",       unit: "rec",      kind: "ou",  stat: ["receptions"] },
  rec_tds:      { label: "Receiving TDs",    unit: "rec TDs",  kind: "ou",  stat: ["receivingTouchdowns"] },
  rush_rec_yds: { label: "Rush + Rec Yards", unit: "yds",      kind: "ou",  stat: ["rushingYards", "receivingYards"] },
  // Anytime TD = the player crosses the goal line ANY way — rush, reception, OR a
  // return / defensive score (kick/punt return, pick-six, fumble-return). Passing
  // TDs are excluded (the QB doesn't score). It's a yes/no market, so overlapping
  // ESPN keys (a pick-six counts under both interception- and defensive-TDs) are
  // harmless — any positive sum means the player scored. Keys verified against live
  // ESPN box scores (kick/punt/interception/defensive TDs).
  anytime_td:   { label: "Anytime TD",       unit: "TD",       kind: "yes", stat: ["rushingTouchdowns", "receivingTouchdowns", "kickReturnTouchdowns", "puntReturnTouchdowns", "interceptionTouchdowns", "defensiveTouchdowns"] },
};

// Plausible price band for a MAIN two-sided over/under prop side. A main line is
// set near the median outcome, so both the over and under carry near-even juice
// (roughly -300..+250 in the wild). A "main" O/U side priced far outside this
// band — e.g. +1400 on a 232.5 passing-yards over — is bad or mislabeled data (a
// longshot alt bucketed as main, or a feed error), never a real main line. Such a
// price must not become a lockable Super Lock (the league's floor rule only bars
// odds SHORTER than -120, so a bogus +1400 would otherwise pass and be the most
// tempting thing to lock). We drop the price at normalization so the side is not
// lockable. Alt buy-up lines are stored separately and keep their own long odds,
// so legitimate longshot alternates are unaffected.
const MAIN_OU_PRICE_MIN = -2500, MAIN_OU_PRICE_MAX = 600;
export function plausibleMainPrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n >= MAIN_OU_PRICE_MIN && n <= MAIN_OU_PRICE_MAX;
}

// Preferred order in the picker (most-locked first).
export const PROP_ORDER = [
  "anytime_td", "rush_yds", "rec_yds", "receptions", "pass_yds", "pass_tds",
  "rush_att", "rush_tds", "rec_tds", "rush_rec_yds", "pass_cmp", "pass_att", "pass_int",
];

// Map a provider's own market name onto one of our canonical keys. Providers
// disagree on wording ("player_rush_yds" vs "Rushing Yards" vs "rush_reception_yds"),
// so we first fold the vocabulary to a common token set, then walk an explicit
// decision tree (combos and TD/yardage variants before the plain keys).
// Unsupported market labels must not become supported through a broad stat-category fallback.
function unsupportedPropMarket(raw) {
  const n = String(raw || "").toLowerCase().replace(/[_+]+/g, " ");
  return /\b(longest|shortest|half|quarter|period|1st|2nd|3rd|4th|first|last|second|third|fourth|1h|2h|q1|q2|q3|q4)\b/.test(n) ||
    (n.includes("pass") && n.includes("rush"));
}
export function marketKeyFromName(raw) {
  let n = String(raw || "").toLowerCase().replace(/[_+]+/g, " ");
  if (!n || unsupportedPropMarket(raw)) return null;
  // Reject derivative / non-full-game markets that share a base stat's keywords
  // and would otherwise mis-map onto it. A "longest reception" market contains
  // "reception"; a half/quarter split contains "receiving yards"; etc. These
  // arrive as their own main-flagged Over/Under rows and, bucketed onto
  // receptions / receiving yards, overwrite the real full-game line (observed on
  // DraftKings: Kupp/Doubs receptions showing 15+, A.J. Brown receiving yards
  // showing ~19). We only grade full-game totals, so drop them here.
  if (/\b(longest|shortest|half|quarter|period|1st|2nd|3rd|4th|first|last|second|third|fourth|1h|2h|q1|q2|q3|q4)\b/.test(n)) return null;
  const pre = n; // separators normalized to spaces, before the stat folds below
  n = n
    .replace(/yds/g, "yards")
    .replace(/touchdowns?/g, "td")
    .replace(/receiving/g, "reception")
    .replace(/completions?/g, "comp")
    .replace(/attempts?|carries|carry/g, "attempt")
    .replace(/interceptions?/g, "int");
  const yard = n.includes("yard"), td = n.includes("td");
  const rush = n.includes("rush"), pass = n.includes("pass");
  const rec = n.includes("recept") || /\brec\b/.test(n);
  if (n.includes("anytime") && td) return "anytime_td";
  if (rush && rec && yard) return "rush_rec_yds";
  if (rush) {
    if (yard) return "rush_yds";
    if (td) return "rush_tds";
    if (n.includes("attempt")) return "rush_att";
  }
  if (rec) {
    if (yard) return "rec_yds";
    if (td) return "rec_tds";
    return "receptions";
  }
  if (pass) {
    if (yard) return "pass_yds";
    if (td) return "pass_tds";
    if (/\bint\b/.test(n)) return "pass_int";
    if (/\bcomp\b/.test(n)) return "pass_cmp";
    if (n.includes("attempt")) return "pass_att";
  }
  // Passing-by-nature stats books sometimes post without the "pass" token, and
  // "carries" is a rushing-attempts market (folded to "attempt" above but with no
  // rush token). Word-bounded so "points" (po-int-s) never reads as interceptions.
  if (/\bcomp\b/.test(n)) return "pass_cmp";
  if (/\bint\b/.test(n)) return "pass_int";
  if (/\bcarr/.test(pre)) return "rush_att"; // "carries" folded to "attempt" in n
  return null;
}

// ── SharpAPI prop normalization ──────────────────────────────────────────────
// SharpAPI returns a flat row per selection (same schema as the spread/total
// feed). A player-prop row carries: is_player_prop, market_type, selection
// (player name), selection_type ("over"/"under"/"yes"/"no"), line, odds_american,
// is_main_line, home/away. We bucket by (market,player), keep the MAIN line,
// and expose both books' prices. Team names come from the row so the picker can
// scope props to a specific game.
const SHARP_BOOK = (sb) => {
  const s = String(sb || "").toLowerCase();
  if (s.includes("fanduel") || s === "fd") return "fanduel";
  if (s.includes("draftking") || s === "dk") return "draftkings";
  return null;
};

// SharpAPI's `player_touchdowns` market_type is generic — the main Over/Under
// row (market_type/market_ref/stat_category all just "touchdowns") does NOT say
// whether it's passing/rushing/receiving/anytime TDs. Only the sibling cumulative
// selections ("Drake Maye 2+ Passing Touchdowns") carry the subtype. So we scan
// those to learn each player's TD flavor, then map the O/U line onto the matching
// gradable market. Unknown/absent subtype -> the row is dropped (grade-safe).
function tdSubtypeFromSelection(sel) {
  const s = String(sel || "").toLowerCase();
  if (/\b(first|last)\b/.test(s)) return null;
  if (s.includes("passing")) return "pass_tds";
  if (s.includes("rushing")) return "rush_tds";
  if (s.includes("receiving")) return "rec_tds";
  if (/\banytime\b|to score a touchdown/.test(s)) return "anytime_td";
  return null;
}

// SharpAPI ships alternate lines as cumulative "N+ <Stat>" selections
// (selection_type "other"), e.g. "Cooper Kupp 4+ Receptions". "N+" is an OVER at
// line N-0.5 with its own odds — buying up the line (higher N) lengthens the
// payout. Returns the threshold N, or null for a non-alt selection.
function altThreshold(sel) {
  const m = String(sel || "").match(/\b(\d+)\s*\+/);
  return m ? Number(m[1]) : null;
}

export function normalizeSharpProps(rows) {
  // Pre-scan: resolve each player's touchdown subtype from the cumulative
  // ("N+ <flavor> Touchdowns") selection strings before mapping the O/U rows.
  const tdMap = new Map();
  for (const r of rows || []) {
    if (!/touchdown/i.test(String(r.market_type || "")) &&
        !/touchdown/i.test(String(r.stat_category || ""))) continue;
    const sub = tdSubtypeFromSelection(r.selection);
    if (!sub) continue;
    const key = String(r.player_name ?? r.player ?? "").toLowerCase().trim();
    if (key && !tdMap.has(key)) tdMap.set(key, sub);
  }

  // key = `${market}|${player}` -> aggregate across books + over/under sides.
  const agg = new Map();
  for (const r of rows || []) {
    if (r.is_active === false || r.is_stale_pregame_price === true || r.is_impossible_scoreline === true) continue;
    if (unsupportedPropMarket(r.market_type) || unsupportedPropMarket(r.stat_category)) continue;
    const isProp = r.is_player_prop === true ||
      /player|prop/i.test(String(r.market_type || "")) ||
      marketKeyFromName(r.market_type) != null;
    if (!isProp) continue;
    // Player name lives in `player_name` (the `selection` field is the O/U side).
    const namedScorerMarket = marketKeyFromName(r.market_type) === "anytime_td";
    const player = String(r.player_name ?? r.player ?? (namedScorerMarket ? r.selection : "")).trim();
    if (namedScorerMarket && /\b(defen[cs]e|d\/st|special teams|no touchdown|no scorer|other|field|yes|no|over|under)\b/i.test(player)) continue;
    if (!player) continue;
    // Resolve the gradable market from the market_type, falling back to the
    // semantic stat_category (both use the same tolerant token map, so
    // player_receiving_yards / receiving_yards / "Receiving Yards" all land on
    // rec_yds). A generic touchdowns market (null from marketKeyFromName) is
    // disambiguated by the player's scanned TD subtype.
    let market = marketKeyFromName(r.market_type) || marketKeyFromName(r.stat_category);
    if (!market && (/touchdown/i.test(String(r.market_type || "")) ||
                    /touchdown/i.test(String(r.stat_category || "")))) {
      market = tdMap.get(player.toLowerCase()) || null;
    }
    if (!market) continue;
    const book = SHARP_BOOK(r.sportsbook);
    if (!book) continue;
    const def = PROP_DEFS[market];
    const line = Number(r.line ?? r.point ?? r.handicap);
    const price = Number.isFinite(Number(r.odds_american)) ? Number(r.odds_american) : null;
    const isMain = r.is_main_line === true;
    const stype = String(r.selection_type ?? "").toLowerCase();
    const home = r.home_team ?? r.home?.name ?? r.home;
    const away = r.away_team ?? r.away?.name ?? r.away;
    const kickoff = r.event_start_time ?? r.start_time ?? r.commence_time ?? r.kickoff ?? null;

    const id = `${market}|${player.toLowerCase()}`;
    let e = agg.get(id);
    if (!e) { e = { market, label: def.label, unit: def.unit, kind: def.kind, player, home, away, kickoff, byBook: {}, ouByBook: {}, altByBook: {} }; agg.set(id, e); }
    if (def.kind === "yes") {
      // Named scorer markets use selection_type=other and is_player_prop=false.
      // Only a named player's unlined anytime outcome is equivalent to Yes.
      const namedScorer = namedScorerMarket && stype === "other" && r.line == null &&
        r.is_alternate_line !== true && String(r.selection || "").trim().toLowerCase() === player.toLowerCase();
      const yes = stype === "yes" || (stype === "over" && line === 0.5) || namedScorer;
      if (!yes || price == null || Math.abs(price) < 100) continue;
      const b = e.byBook[book] || (e.byBook[book] = { over: null, under: null, yes: null, line: null, main: false });
      b.yes = price; b.updated = r.timestamp || null;
      if (isMain) b.main = true;
    } else if (stype === "over" || stype === "under") {
      // Over/Under row. Books disagree on how they ship the line ladder: FanDuel
      // posts only the MAIN line as over/under (alternates come as "other" "N+"
      // rows, handled below), but DraftKings posts EVERY alternate line as its own
      // over/under row with is_main_line=false — and often doesn't flag the real
      // main at all. So we can't treat "first over/under row" as the main line
      // (that let a DK alt like 19.5 masquerade as A.J. Brown's 63.5 line). Collect
      // every line per book here; resolveMainLine() picks the true main in flatten.
      if (!Number.isFinite(line)) continue;
      const m = e.ouByBook[book] || (e.ouByBook[book] = new Map());
      const slot = m.get(line) || m.set(line, { over: null, under: null, main: false }).get(line);
      if (slot[stype] == null) { slot[stype] = price; (slot.updated ||= {})[stype] = r.timestamp || null; }
      if (isMain) slot.main = true;
    } else {
      // Alternate over line: a cumulative "N+ <Stat>" selection -> over at N-0.5
      // with its own odds. Bucket per book so the picker can offer buy-up lines.
      const n = altThreshold(r.selection);
      if (n != null && price != null) {
        (e.altByBook[book] || (e.altByBook[book] = new Map())).set(n - 0.5, price);
        ((e.altUpdated ||= {})[book] ||= new Map()).set(n - 0.5, r.timestamp || null);
      }
    }
  }
  // Pick a book's true main line out of the collected over/under ladder: prefer a
  // line flagged is_main_line (and, among those, one that is two-sided), then any
  // two-sided line (both over and under — alternates are over-only), then any line
  // carrying an under. A ladder of over-only lines has no genuine main -> null.
  const resolveMainLine = (m) => {
    if (!m || !m.size) return null;
    const lines = [...m.keys()];
    const twoSided = (l) => m.get(l).over != null && m.get(l).under != null;
    const flagged = lines.filter((l) => m.get(l).main);
    const pick =
      flagged.find(twoSided) ??
      (flagged.length ? Math.min(...flagged) : undefined) ??
      (lines.some(twoSided) ? Math.min(...lines.filter(twoSided)) : undefined) ??
      (lines.some((l) => m.get(l).under != null) ? Math.min(...lines.filter((l) => m.get(l).under != null)) : undefined);
    if (pick === undefined) return null;
    const slot = m.get(pick);
    // Keep the +1400-style price safety: an implausible main-line price is dropped.
    return { line: pick, over: plausibleMainPrice(slot.over) ? slot.over : null, under: plausibleMainPrice(slot.under) ? slot.under : null };
  };
  // Flatten to the picker shape: one entry per (market, player) with the best
  // available line + both books' prices.
  const out = [];
  for (const e of agg.values()) {
    if (e.kind === "yes") {
      // Anytime TD: yes/no market, no line ladder.
      const fd = e.byBook.fanduel, dk = e.byBook.draftkings;
      if (fd?.yes == null && dk?.yes == null) continue;
      const line = (fd && fd.line != null) ? fd.line : (dk && dk.line != null ? dk.line : null);
      out.push({
        market: e.market, label: e.label, unit: e.unit, kind: e.kind,
        player: e.player, home: e.home, away: e.away, kickoff: e.kickoff, line,
        fanduel: fd ? { line: fd.line, over: fd.over, under: fd.under, yes: fd.yes } : null,
        draftkings: dk ? { line: dk.line, over: dk.over, under: dk.under, yes: dk.yes } : null,
        alts: [],
      });
      continue;
    }
    // Over/Under: resolve each book's true main line from its ladder.
    const fdMain = resolveMainLine(e.ouByBook.fanduel);
    const dkMain = resolveMainLine(e.ouByBook.draftkings);
    const line = (fdMain && fdMain.line != null) ? fdMain.line : (dkMain && dkMain.line != null ? dkMain.line : null);
    if (line == null) continue;
    // Every over line other than the main one is an alternate (a "buy up the
    // line" price). Fold DraftKings' explicit alternate over/under rows into the
    // same alt map that carries FanDuel's "N+" alternates, without clobbering.
    for (const bk of ["fanduel", "draftkings"]) {
      const m = e.ouByBook[bk]; if (!m) continue;
      const mainLine = bk === "fanduel" ? fdMain?.line : dkMain?.line;
      for (const [ln, slot] of m) {
        if (ln === mainLine || slot.over == null) continue;
        const map = e.altByBook[bk] || (e.altByBook[bk] = new Map());
        if (!map.has(ln)) map.set(ln, slot.over);
      }
    }
    // Alternate OVER lines above the main line — union thresholds across books,
    // keep each book's price, sorted by line (higher = harder = longer odds).
    const lineSet = new Set();
    for (const bk of Object.keys(e.altByBook)) for (const ln of e.altByBook[bk].keys()) if (ln > line) lineSet.add(ln);
    const alts = [...lineSet].sort((a, b) => a - b).map((ln) => ({
      line: ln,
      fanduel: e.altByBook.fanduel ? (e.altByBook.fanduel.get(ln) ?? null) : null,
      draftkings: e.altByBook.draftkings ? (e.altByBook.draftkings.get(ln) ?? null) : null,
    }));
    out.push({
      market: e.market, label: e.label, unit: e.unit, kind: e.kind,
      player: e.player, home: e.home, away: e.away, kickoff: e.kickoff, line,
      fanduel: fdMain ? { line: fdMain.line, over: fdMain.over, under: fdMain.under, yes: null } : null,
      draftkings: dkMain ? { line: dkMain.line, over: dkMain.over, under: dkMain.under, yes: null } : null,
      alts,
    });
  }
  for (const p of out) {
    const e = agg.get(`${p.market}|${p.player.toLowerCase()}`);
    for (const book of ['fanduel', 'draftkings']) {
      const b = p[book];
      if (b) {
        const slot = e.ouByBook[book]?.get(b.line);
        const stamps = p.kind === 'yes' ? [e.byBook[book]?.updated] : [slot?.updated?.over, slot?.updated?.under];
        if (stamps.some(Boolean)) b.updated = stamps.every(Boolean) ? stamps.sort()[0] : null;
      }
      for (const alt of p.alts || []) {
        const stamp = e.altUpdated?.[book]?.get(alt.line) || e.ouByBook[book]?.get(alt.line)?.updated?.over;
        if (stamp) (alt.updated ||= {})[book] = stamp;
      }
    }
  }
  return out;
}

// ── ESPN box-score grading ───────────────────────────────────────────────────
const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/gi;
export function normPlayer(s) {
  return String(s || "").toLowerCase().replace(/[.'-]/g, " ").replace(SUFFIX, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
// Match a prop player name to a box-score athlete name. Exact normalized match
// first, then last-name + first-initial (handles "P. Mahomes" vs "Patrick
// Mahomes" and nickname/suffix noise).
export function samePlayer(a, b) {
  const na = normPlayer(a), nb = normPlayer(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = na.split(" "), pb = nb.split(" ");
  const lastA = pa[pa.length - 1], lastB = pb[pb.length - 1];
  if (lastA && lastA === lastB && pa[0] && pb[0] && pa[0][0] === pb[0][0]) return true;
  return false;
}

// Build a flat {statKey: number} map for a single athlete from an ESPN box
// score, across passing/rushing/receiving. Expands combined ESPN cells
// ("13/20" under key "completions/passingAttempts", "3-9" under
// "sacks-sackYardsLost") into their individual stats.
export function playerStatMap(boxscore, playerName) {
  const map = {};
  let found = false;
  for (const team of boxscore?.players || []) {
    for (const cat of team.statistics || []) {
      const keys = cat.keys || [];
      for (const a of cat.athletes || []) {
        if (!samePlayer(a.athlete?.displayName || a.athlete?.shortName, playerName)) continue;
        found = true;
        const stats = a.stats || [];
        keys.forEach((k, i) => {
          const v = stats[i];
          if (k.includes("/") && String(v).includes("/")) {
            const ks = k.split("/"), vs = String(v).split("/");
            ks.forEach((kk, j) => { map[kk] = Number(vs[j]); });
          } else if (k.includes("-") && String(v).includes("-")) {
            const ks = k.split("-"), vs = String(v).split("-");
            ks.forEach((kk, j) => { map[kk] = Number(vs[j]); });
          } else {
            map[k] = Number(v);
          }
        });
      }
    }
  }
  return found ? map : null;
}

// Sum the ESPN stats a market maps to (missing stats count as 0 once the
// player is found, so a pure receiver still grades a rush+rec market).
function statTotal(map, market) {
  const def = PROP_DEFS[market];
  if (!def) return null;
  let total = 0;
  for (const k of def.stat) total += Number.isFinite(map[k]) ? map[k] : 0;
  return total;
}

// Grade a structured prop against a final box score.
// prop = { market, player, line, side }  where side ∈ 'over'|'under'|'yes'.
// Returns 'W' | 'L' | 'P', or null if it can't be resolved (leave for manual).
export function gradeProp(prop, boxscore) {
  const def = PROP_DEFS[prop?.market];
  if (!def) return null;
  const map = playerStatMap(boxscore, prop.player);
  if (!map) return null; // player didn't appear / name didn't match -> manual
  const actual = statTotal(map, prop.market);
  if (actual == null || !Number.isFinite(actual)) return null;
  if (def.kind === "yes") {
    // Anytime TD (yes). A miss is a clean loss (player was in the box score).
    const scored = actual >= 1;
    return prop.side === "no" ? (scored ? "L" : "W") : (scored ? "W" : "L");
  }
  const line = Number(prop.line);
  if (!Number.isFinite(line)) return null;
  if (actual === line) return "P";
  const over = actual > line;
  return prop.side === "under" ? (over ? "L" : "W") : (over ? "W" : "L");
}

// Canonical human-readable text for a structured prop, used as pick_text.
export function propPickText(prop) {
  const def = PROP_DEFS[prop?.market];
  if (!def) return prop?.player || "";
  if (def.kind === "yes") return `${prop.player} anytime TD`;
  const dir = prop.side === "under" ? "u" : "o";
  return `${prop.player} ${dir}${prop.line} ${def.unit}`;
}
