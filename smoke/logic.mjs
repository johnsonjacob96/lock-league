// Deterministic Week-1 simulation against the REAL app logic (no network, no DB).
// Feeds simulated SharpAPI/ESPN data through the same functions the handlers use:
// board normalization, prop menu + alt lines, pick anti-cheat re-derivation, the
// started/Monday guards, and grading. This is the primary bug net before Week 1.
import { suite } from "./assert.mjs";
import { normalizeSharp, fetchSharpRaw } from "../functions/api/odds.js";
import { normalizeSharpProps } from "../functions/_shared/props.js";
import { menuForGame } from "../functions/api/props.js";
import { deriveProp, deriveGradable, findGame, findStartedGame, findMondayGame } from "../functions/api/picks.js";
import { gradeProp } from "../functions/_shared/props.js";
import { gradeTotal, resolveSpreadResult, resolvePickResult } from "../functions/_shared/grader.js";
import { anytimeTdMarketFromOdds } from "../functions/_shared/oddsapi-props.js";
import { sharpBoardRows, sharpPropRows, scoreboard, boxscoreG1, KEYS } from "./fixtures.mjs";

const LOCK_MIN = -120; // league rule: Super Lock odds must be -120 or longer
const lockable = (price) => price != null && Number(price) >= LOCK_MIN;

export async function run() {
  const s = suite("logic — Week-1 simulation (board · props · picks · grading)");

  // ── 1. Board: derivative markets must never reach the game spread/total ──
  const games = normalizeSharp(sharpBoardRows());
  s.eq("board parses 3 games", games.length, 3);
  const g1 = findGame(games, KEYS.G1), g2 = findGame(games, KEYS.G2), gm = findGame(games, KEYS.GM);
  s.eq("SEA/NE game total is the game line (44.5), not team/half/TD", g1?.books?.fanduel?.total?.point, 44.5);
  s.eq("LAR/SF game total 48.5", g2?.books?.fanduel?.total?.point, 48.5);
  s.ok("no game total is a leaked derivative (<30)", games.every(g => (g.books.fanduel.total?.point ?? 99) >= 30),
    "a total below 30 means a team/period/TD total leaked onto the board");
  s.eq("SEA spread fav + line", [g1?.books?.fanduel?.spread?.fav, g1?.books?.fanduel?.spread?.line], ["Seattle Seahawks", -3.5]);

  // ── 2. Props: mapping, player name, and alt "buy up" lines ──
  const props = normalizeSharpProps(sharpPropRows());
  const menu = menuForGame(props, "New England Patriots", "Seattle Seahawks");
  const mkt = (k) => menu.find(m => m.market === k);
  const player = (k, re) => mkt(k)?.players.find(p => re.test(p.player));
  s.ok("receptions market present", !!mkt("receptions"));
  s.ok("passing-TD market present (subtype-resolved from 'N+ Passing Touchdowns')", !!mkt("pass_tds"));
  s.ok("rushing-yards market present", !!mkt("rush_yds"));
  s.ok("anytime-TD market present", !!mkt("anytime_td"));
  const kupp = player("receptions", /Kupp/);
  s.eq("Kupp receptions main line 2.5", kupp?.line, 2.5);
  s.eq("Kupp alt lines are the buy-ups above main (3.5, 4.5); 3+ (==main) & lower excluded",
    (kupp?.alts || []).map(a => a.line), [3.5, 4.5]);
  s.ok("no player labelled 'Over'/'Under' (player_name used, not selection)",
    menu.every(m => m.players.every(p => !/^over$|^under$/i.test(p.player))));

  // ── 3. Pick anti-cheat: the server re-derives line/price from the live board ──
  const dMain = deriveProp(menu, { market: "receptions", player: "Cooper Kupp", line: 2.5, side: "over", book: "fanduel" });
  s.eq("main Kupp o2.5 re-derives to -148", dMain?.price, -148);
  const dAlt = deriveProp(menu, { market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over", book: "fanduel" });
  s.eq("alt Kupp o3.5 re-derives from board (+280)", [dAlt?.line, dAlt?.price], [3.5, 280]);
  s.eq("fabricated alt line (9.5) is rejected", deriveProp(menu, { market: "receptions", player: "Cooper Kupp", line: 9.5, side: "over", book: "fanduel" }), null);
  const dInject = deriveProp(menu, { market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over", book: "fanduel", price: 99999 });
  s.eq("client-supplied price is ignored (board wins)", dInject?.price, 280);
  s.ok("unknown player is rejected", deriveProp(menu, { market: "receptions", player: "Nobody At All", line: 2.5, side: "over", book: "fanduel" }) === null);

  // ── 3b. The -120 lock rule (enforced by the handler on the derived price) ──
  s.ok("main -148 favorite line is NOT lockable (shorter than -120)", !lockable(dMain.price));
  s.ok("alt +280 line IS lockable (buy up unlocks it)", lockable(dAlt.price));

  // ── 4. Game-line Super Lock derivation ──
  const favD = deriveGradable(g1, "Favorite", "fav", "fanduel");
  s.eq("Favorite derives SEA -3.5", [favD?.line, favD?.pick_text], [-3.5, "Seattle Seahawks -3.5"]);
  const overD = deriveGradable(g1, "Over", "over", "fanduel");
  s.eq("Over derives total 44.5", overD?.line, 44.5);

  // ── 5. Guards: started-game + Monday (both caused real bugs) ──
  const started = [{ away: "New England Patriots", home: "Seattle Seahawks", kickoff: "2000-01-01T00:00Z" }];
  const future = [{ away: "New England Patriots", home: "Seattle Seahawks", kickoff: "2999-01-01T00:00Z" }];
  s.ok("started-game guard rejects a pick on a kicked-off game", !!findStartedGame([{ game_key: KEYS.G1 }], started));
  s.ok("started-game guard passes a future game", findStartedGame([{ game_key: KEYS.G1 }], future) === null);
  const sb = scoreboard();
  s.ok("Monday guard rejects an MNF pick (KC/DEN, Mon 7:20 CT)", !!findMondayGame([{ game_key: KEYS.GM }], sb));
  s.ok("Monday guard passes a non-Monday game", findMondayGame([{ game_key: KEYS.G1 }], sb) === null);

  // ── 6. Grading: props (incl alt lines, push, missing) + game lines ──
  const box = boxscoreG1(); // Kupp 4 rec, Maye 2 pass TD, Walker 72 rush + 1 rush TD
  s.eq("grade Kupp o3.5 rec (actual 4) -> W", gradeProp({ market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over" }, box), "W");
  s.eq("grade Kupp o4.5 rec (actual 4) -> L", gradeProp({ market: "receptions", player: "Cooper Kupp", line: 4.5, side: "over" }, box), "L");
  s.eq("grade Kupp receptions exact line 4 -> P (push)", gradeProp({ market: "receptions", player: "Cooper Kupp", line: 4, side: "over" }, box), "P");
  s.eq("grade Maye pass_tds o1.5 (actual 2) -> W", gradeProp({ market: "pass_tds", player: "Drake Maye", line: 1.5, side: "over" }, box), "W");
  s.eq("grade Walker rush_yds o68.5 (actual 72) -> W", gradeProp({ market: "rush_yds", player: "Kenneth Walker III", line: 68.5, side: "over" }, box), "W");
  s.eq("grade Walker rush_yds u68.5 -> L", gradeProp({ market: "rush_yds", player: "Kenneth Walker III", line: 68.5, side: "under" }, box), "L");
  s.eq("grade Walker anytime TD yes (1 rush TD) -> W", gradeProp({ market: "anytime_td", player: "Kenneth Walker III", side: "yes" }, box), "W");
  // Anytime TD counts return + defensive scores, not just rush/rec.
  s.eq("grade anytime TD: pick-six (interception/defensive TD, no rush/rec) -> W", gradeProp({ market: "anytime_td", player: "Devon Witherspoon", side: "yes" }, box), "W");
  s.eq("grade anytime TD: kick-return TD -> W", gradeProp({ market: "anytime_td", player: "Zach Charbonnet", side: "yes" }, box), "W");
  s.eq("grade anytime TD: player who scored no TD of any kind -> L", gradeProp({ market: "anytime_td", player: "Cooper Kupp", side: "yes" }, box), "L");
  s.eq("grade unknown player -> null (falls to manual)", gradeProp({ market: "rush_yds", player: "Ghost Player", line: 10, side: "over" }, box), null);

  const evSea = sb.find(e => e.home === "Seattle Seahawks");   // SEA 27 NE 20
  const evLar = sb.find(e => e.home === "Los Angeles Rams");   // 24-24 tie
  s.eq("grade Favorite SEA -3.5 (win by 7) -> W", resolveSpreadResult({ side: "fav", line: -3.5, pick_text: "Seattle Seahawks -3.5" }, evSea), "W");
  s.eq("grade Dog SF +2.5 (tie) -> W", resolveSpreadResult({ side: "dog", line: -2.5, pick_text: "San Francisco 49ers +2.5" }, evLar), "W");
  s.eq("grade Over 44.5 (total 47) -> W", gradeTotal("over", 44.5, evSea.away_score + evSea.home_score), "W");
  s.eq("grade Under 44.5 (total 47) -> L", gradeTotal("under", 44.5, evSea.away_score + evSea.home_score), "L");
  s.eq("grade total push (line 47, total 47) -> P", gradeTotal("over", 47, 47), "P");

  // ── 7. Grading ROUTER: the exact bet_type + prop_meta routing gradeWeek uses ──
  // (auto-grade pipeline minus ESPN/DB — box score is injected). Catches a pick
  // being sent to the wrong grader, or free-text/missing data being auto-graded.
  const evR = { ...evSea, id: "SEA1" };                    // SEA 27 NE 20, total 47
  const getBox = async (id) => (id === "SEA1" ? box : null);
  const route = (p) => resolvePickResult(p, evR, getBox);
  s.eq("router: Favorite -> spread grader (W)", await route({ bet_type: "Favorite", side: "fav", line: -3.5, pick_text: "Seattle Seahawks -3.5" }), "W");
  s.eq("router: Over -> total grader (W)", await route({ bet_type: "Over", side: "over", line: 44.5 }), "W");
  s.eq("router: Super Lock spread (prop_meta.kind=spread) -> spread grader (W)", await route({ bet_type: "Super Lock", side: "fav", line: -3.5, pick_text: "Seattle Seahawks -3.5", prop_meta: { kind: "spread" } }), "W");
  s.eq("router: Super Lock total (prop_meta.kind=total) -> total grader (W)", await route({ bet_type: "Super Lock", side: "over", line: 44.5, prop_meta: { kind: "total" } }), "W");
  s.eq("router: Super Lock player prop -> box-score grader (Kupp o3.5, 4 rec, W)", await route({ bet_type: "Super Lock", prop_meta: { market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over" } }), "W");
  s.eq("router: Super Lock alt-line prop (o4.5, 4 rec, L)", await route({ bet_type: "Super Lock", prop_meta: { market: "receptions", player: "Cooper Kupp", line: 4.5, side: "over" } }), "L");
  s.eq("router: prop_meta stored as a JSON string is parsed (Maye pass_tds o1.5, W)", await route({ bet_type: "Super Lock", prop_meta: JSON.stringify({ market: "pass_tds", player: "Drake Maye", line: 1.5, side: "over" }) }), "W");
  s.eq("router: free-text Super Lock (no prop_meta) -> null (manual, never auto-graded)", await route({ bet_type: "Super Lock", prop_meta: null }), null);
  s.eq("router: Over with a null final score -> null (not graded yet)", await resolvePickResult({ bet_type: "Over", side: "over", line: 44.5 }, { ...evR, home_score: null }, getBox), null);
  s.eq("router: player prop but box fetch fails -> null (retry next run, not a loss)", await resolvePickResult({ bet_type: "Super Lock", prop_meta: { market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over" } }, { ...evR, id: "MISSING" }, getBox), null);

  // ── 8. SharpAPI rate-limit resilience: a mid-pagination 429 must not blank ──
  // the whole pull (that was the "props show up inconsistently" bug — a 429 on a
  // later page threw away every prior page, and the empty menu got cached).
  const realFetch = globalThis.fetch;
  const fakeRes = (status, json) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => json, text: async () => JSON.stringify(json),
  });
  const env = { SHARPAPI_KEY: "test" };
  try {
    // Page 0 succeeds (2 rows, more available); page 1 is rate-limited.
    let call = 0;
    globalThis.fetch = async () => (call++ === 0
      ? fakeRes(200, { data: [{ id: "p0a" }, { id: "p0b" }], pagination: { has_more: true, next_cursor: "c1" } })
      : fakeRes(429, { error: { code: "rate_limited" } }));
    const partial = await fetchSharpRaw(env, 4, { market: "props" });
    s.eq("fetchSharpRaw: 429 mid-pagination keeps page-0 rows (partial, not blank)", partial.map(r => r.id), ["p0a", "p0b"]);

    // Page 0 itself is rate-limited: nothing to salvage -> surfaces the error so
    // the caller serves last-good instead of caching an empty menu.
    globalThis.fetch = async () => fakeRes(429, { error: { code: "rate_limited" } });
    let threw = false;
    try { await fetchSharpRaw(env, 4, { market: "props" }); } catch { threw = true; }
    s.ok("fetchSharpRaw: 429 on page 0 throws (no rows to salvage)", threw);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ── 9. Anytime TD from The Odds API: mapping + it flows through deriveProp ──
  // SharpAPI lacks anytime-TD; we source it from The Odds API and shape it as an
  // `anytime_td` market so the existing menu/derive/grade path handles it.
  const oddsPayload = {
    bookmakers: [
      { key: "draftkings", markets: [{ key: "player_anytime_td", outcomes: [
        { name: "Yes", description: "A.J. Brown", price: 160 },
        { name: "Yes", description: "Saquon Barkley", price: -140 },
        { name: "No", description: "Saquon Barkley", price: 110 },  // No side must be ignored
      ] }] },
      { key: "fanduel", markets: [{ key: "player_anytime_td", outcomes: [
        { name: "Yes", description: "A.J. Brown", price: 165 },
        { name: "Yes", description: "Saquon Barkley", price: -135 },
      ] }] },
      { key: "betmgm", markets: [{ key: "player_anytime_td", outcomes: [
        { name: "Yes", description: "A.J. Brown", price: 150 },  // non-FD/DK book must be ignored
      ] }] },
    ],
  };
  const atd = anytimeTdMarketFromOdds(oddsPayload);
  s.eq("anytime-td: market shape", [atd.market, atd.kind, atd.label], ["anytime_td", "yes", "Anytime TD"]);
  s.eq("anytime-td: 2 players (No side + non-FD/DK book dropped)", atd.players.length, 2);
  // Ordered by odds, most-likely first: Saquon (best -135) above A.J. Brown (best +165).
  s.eq("anytime-td: ordered by odds (favorite first, longshots last)", atd.players.map((p) => p.player), ["Saquon Barkley", "A.J. Brown"]);
  const brown = atd.players.find((p) => p.player === "A.J. Brown");
  s.eq("anytime-td: A.J. Brown FD+DK Yes prices", [brown.draftkings.yes, brown.fanduel.yes], [160, 165]);
  s.ok("anytime-td: no line, no No-side price leaked", brown.line === null && brown.draftkings.yes === 160);
  // Now lock it like the picker would: deriveProp re-derives price/book off the menu.
  const d = deriveProp([atd], { market: "anytime_td", player: "A.J. Brown", side: "yes", book: "fanduel" });
  s.eq("anytime-td: deriveProp -> yes @ FD 165, no line", [d.market, d.side, d.line, d.price, d.book], ["anytime_td", "yes", null, 165, "fanduel"]);
  s.eq("anytime-td: deriveProp rejects a player not on the board", deriveProp([atd], { market: "anytime_td", player: "Nobody At All", side: "yes" }), null);
  s.eq("anytime-td: empty payload -> null (no market)", anytimeTdMarketFromOdds({ bookmakers: [] }), null);

  return s;
}
