// Anytime-TD-scorer props from The Odds API.
//
// SharpAPI (our primary prop feed) does NOT carry an anytime-TD-scorer market —
// only QB passing TDs. The Odds API does (`player_anytime_td`), FD+DK, so we pull
// it from there and shape it exactly like a normalizeSharpProps `anytime_td`
// market. That means the existing menu (menuForGame), lock anti-cheat (deriveProp,
// kind==="yes" branch), and box-score grading (PROP_DEFS.anytime_td) all handle it
// unchanged — this module only sources the lines.
//
// Cost: The Odds API `/events` list is FREE (no odds); each `/events/{id}/odds`
// pull is 1 credit. So callers cache aggressively and fetch per game lazily.
import { sameTeam } from "./grader.js";
import { PROP_DEFS } from "./props.js";

const HOST = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl";
const BOOKS = { draftkings: "draftkings", fanduel: "fanduel" };

// Events list — FREE. Returns [{id, home_team, away_team, commence_time}, ...].
export async function oddsApiEvents(env) {
  const r = await fetch(`${HOST}/events?apiKey=${env.ODDS_API_KEY}`);
  if (!r.ok) throw new Error(`oddsapi events ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

// One event's anytime-TD outcomes (FD+DK). 1 credit.
async function anytimeTdForEvent(env, eventId) {
  const u = new URL(`${HOST}/events/${eventId}/odds`);
  u.searchParams.set("apiKey", env.ODDS_API_KEY);
  u.searchParams.set("regions", "us");
  u.searchParams.set("markets", "player_anytime_td");
  u.searchParams.set("oddsFormat", "american");
  u.searchParams.set("bookmakers", "draftkings,fanduel");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`oddsapi odds ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return await r.json();
}

// Map a raw Odds API event-odds payload into our anytime_td market object, or
// null if no Yes prices are present. Pure — exported for tests.
export function anytimeTdMarketFromOdds(payload) {
  const byPlayer = new Map(); // player -> { fanduel:{yes}, draftkings:{yes} }
  for (const bk of (payload && payload.bookmakers) || []) {
    const book = BOOKS[bk.key];
    if (!book) continue;
    const m = (bk.markets || []).find((x) => x.key === "player_anytime_td");
    if (!m) continue;
    for (const o of m.outcomes || []) {
      // Anytime TD is a Yes/No market; we only lock the "Yes" side. Player name
      // is in `description` ("Jaxon Smith-Njigba"); `name` is "Yes"/"No".
      if (String(o.name || "").toLowerCase() !== "yes") continue;
      const player = String(o.description || "").trim();
      const price = Number(o.price);
      if (!player || !Number.isFinite(price)) continue;
      const e = byPlayer.get(player) || byPlayer.set(player, {}).get(player);
      e[book] = { yes: price };
    }
  }
  // Order by the odds the picker actually shows (it displays the highest-payout
  // book per player), shortest first = most likely to score at the top. American
  // odds are monotonic, so ascending numeric value = descending implied
  // probability across the whole range: a -140 favorite sits above +120, which
  // sits above a +550 longshot.
  const bestYes = (p) => {
    const vals = [p.fanduel && p.fanduel.yes, p.draftkings && p.draftkings.yes].filter((v) => Number.isFinite(v));
    return vals.length ? Math.max(...vals) : Infinity; // priceless -> bottom
  };
  const players = [...byPlayer.entries()]
    .map(([player, books]) => ({
      player, line: null, kind: "yes",
      fanduel: books.fanduel || null, draftkings: books.draftkings || null, alts: [],
    }))
    .sort((a, b) => bestYes(a) - bestYes(b) || a.player.localeCompare(b.player));
  if (!players.length) return null;
  const def = PROP_DEFS.anytime_td;
  return { market: "anytime_td", label: def.label, unit: def.unit, kind: def.kind, players };
}

// Fetch + shape the anytime-TD market for one game. Returns the market object or
// null (no key / event not found / market not posted / API error). Fail-soft: the
// caller must never let an Odds API hiccup break the SharpAPI prop menu.
export async function fetchAnytimeTdMarket(env, away, home) {
  if (!env.ODDS_API_KEY) return null;
  const events = await oddsApiEvents(env);
  const ev = events.find((e) =>
    (sameTeam(e.home_team, home) && sameTeam(e.away_team, away)) ||
    (sameTeam(e.home_team, away) && sameTeam(e.away_team, home)));
  if (!ev) return null;
  const odds = await anytimeTdForEvent(env, ev.id);
  return anytimeTdMarketFromOdds(odds);
}
