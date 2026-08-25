// Simulated Week-1 data: raw SharpAPI rows (board + props), final box scores, and
// scoreboard events. Shaped to match what the live feeds actually return (verified
// against production samples on 2026-08-24), including the derivative markets that
// have caused real bugs (team totals, half/quarter lines, "N+" alt props).

const G1 = { away_team: "New England Patriots", home_team: "Seattle Seahawks", event_start_time: "2026-09-10T00:15Z" }; // Wed night
const G2 = { away_team: "San Francisco 49ers", home_team: "Los Angeles Rams", event_start_time: "2026-09-14T20:05Z" };  // Sunday
const GM = { away_team: "Denver Broncos", home_team: "Kansas City Chiefs", event_start_time: "2026-09-15T00:20Z" };      // Mon 7:20pm CT (Tue 00:20 UTC)

const board = (g, o) => ({ sportsbook: "fanduel", is_player_prop: false, is_main_line: true, ...g, ...o });
const prop = (g, o) => ({ sportsbook: "fanduel", is_player_prop: true, is_main_line: true, selection_type: "over", ...g, ...o });

// ── Board rows (spreads + totals + the derivative markets that must be filtered) ──
export function sharpBoardRows() {
  const rows = [];
  const game = (g, fav, favMag, total) => {
    const homeFav = fav === "home";
    rows.push(board(g, { market_type: "point_spread", team_side: "home", point: homeFav ? -favMag : favMag, odds_american: -110 }));
    rows.push(board(g, { market_type: "point_spread", team_side: "away", point: homeFav ? favMag : -favMag, odds_american: -110 }));
    rows.push(board(g, { market_type: "total_points", selection_type: "over", point: total, odds_american: -110 }));
    rows.push(board(g, { market_type: "total_points", selection_type: "under", point: total, odds_american: -110 }));
    // Derivative markets that share the "total"/"spread" keyword — MUST be dropped:
    rows.push(board(g, { market_type: "team_total", selection_type: "over", point: 24.5, odds_american: -110 }));
    rows.push(board(g, { market_type: "team_total", selection_type: "under", point: 24.5, odds_american: -110 }));
    rows.push(board(g, { market_type: "1st_half_total_points", selection_type: "over", point: 22.5, odds_american: -110 }));
    rows.push(board(g, { market_type: "3rd_quarter_point_spread", team_side: "home", point: -1.5, odds_american: -110 }));
    rows.push(board(g, { market_type: "total_touchdowns", selection_type: "over", point: 5.5, odds_american: -110 }));
  };
  game(G1, "home", 3.5, 44.5);  // SEA -3.5, total 44.5
  game(G2, "home", 2.5, 48.5);  // LAR -2.5, total 48.5
  game(GM, "home", 3.0, 43.5);  // KC -3, total 43.5 (Monday game)
  return rows;
}

// ── Prop rows for G1 (SEA/NE): receptions + passing TDs + rushing yards + anytime,
//    each with the cumulative "N+" alternate lines. ──
export function sharpPropRows() {
  const g = G1;
  const R = (o) => prop(g, o);
  return [
    // Cooper Kupp receptions: main O/U 2.5 + alts (4+/5+ are buy-ups; 3+ == main, 2+ < main)
    R({ market_type: "player_receptions", stat_category: "receptions", player_name: "Cooper Kupp", selection: "Over", selection_type: "over", line: 2.5, odds_american: -148 }),
    R({ market_type: "player_receptions", stat_category: "receptions", player_name: "Cooper Kupp", selection: "Under", selection_type: "under", line: 2.5, odds_american: 120 }),
    R({ market_type: "player_receptions", stat_category: "receptions", player_name: "Cooper Kupp", selection: "Cooper Kupp 3+ Receptions", selection_type: "other", odds_american: 130 }),
    R({ market_type: "player_receptions", stat_category: "receptions", player_name: "Cooper Kupp", selection: "Cooper Kupp 4+ Receptions", selection_type: "other", odds_american: 280 }),
    R({ market_type: "player_receptions", stat_category: "receptions", player_name: "Cooper Kupp", selection: "Cooper Kupp 5+ Receptions", selection_type: "other", odds_american: 450 }),
    // Drake Maye passing TDs (generic player_touchdowns, subtype via "N+ Passing Touchdowns")
    R({ market_type: "player_touchdowns", stat_category: "touchdowns", player_name: "Drake Maye", selection: "Over", selection_type: "over", line: 1.5, odds_american: 150 }),
    R({ market_type: "player_touchdowns", stat_category: "touchdowns", player_name: "Drake Maye", selection: "Under", selection_type: "under", line: 1.5, odds_american: -180 }),
    R({ market_type: "player_touchdowns", stat_category: "touchdowns", player_name: "Drake Maye", selection: "Drake Maye 3+ Passing Touchdowns", selection_type: "other", odds_american: 400 }),
    // Kenneth Walker rushing yards
    R({ market_type: "player_rushing_yards", stat_category: "rushing_yards", player_name: "Kenneth Walker III", selection: "Over", selection_type: "over", line: 68.5, odds_american: -114 }),
    R({ market_type: "player_rushing_yards", stat_category: "rushing_yards", player_name: "Kenneth Walker III", selection: "Under", selection_type: "under", line: 68.5, odds_american: -106 }),
    // Walker anytime TD (yes/no)
    R({ market_type: "player_anytime_touchdown", stat_category: "touchdowns", player_name: "Kenneth Walker III", selection: "Yes", selection_type: "yes", odds_american: -140 }),
    R({ market_type: "player_anytime_touchdown", stat_category: "touchdowns", player_name: "Kenneth Walker III", selection: "No", selection_type: "no", odds_american: 110 }),
  ];
}

// Game keys the client builds (`${away}@${home}`).
export const KEYS = {
  G1: "New England Patriots@Seattle Seahawks",
  G2: "San Francisco 49ers@Los Angeles Rams",
  GM: "Denver Broncos@Kansas City Chiefs",
};

// ── Final scoreboard events (for spread/total grading + started/Monday guards) ──
export function scoreboard() {
  return [
    { away: "New England Patriots", home: "Seattle Seahawks", away_score: 20, home_score: 27, kickoff: "2026-09-10T00:15Z", state: "post" }, // SEA by 7 -> SEA -3.5 covers; total 47 > 44.5 over
    { away: "San Francisco 49ers", home: "Los Angeles Rams", away_score: 24, home_score: 24, kickoff: "2026-09-14T20:05Z", state: "post" }, // tie; LAR -2.5 -> SF +2.5 covers; total 48 -> under 48.5
    { away: "Denver Broncos", home: "Kansas City Chiefs", away_score: 17, home_score: 20, kickoff: "2026-09-15T00:20Z", state: "post" },
  ];
}

// ── ESPN-style box score for G1 with the stats our props grade against ──
export function boxscoreG1() {
  const athlete = (name, cat, keys, stats) => ({ athlete: { displayName: name }, stats });
  return {
    players: [
      { statistics: [
        { name: "passing", keys: ["completions/passingAttempts", "passingYards", "passingTouchdowns", "interceptions"],
          athletes: [ athlete("Drake Maye", "passing", null, ["22/31", "268", "2", "0"]) ] },
        { name: "rushing", keys: ["rushingAttempts", "rushingYards", "rushingTouchdowns"],
          athletes: [ athlete("Kenneth Walker III", "rushing", null, ["15", "72", "1"]) ] },
        { name: "receiving", keys: ["receptions", "receivingYards", "receivingTouchdowns"],
          athletes: [ athlete("Cooper Kupp", "receiving", null, ["4", "58", "0"]) ] },
      ] },
    ],
  };
}
