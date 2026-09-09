// Called only after the endpoint's existing local/admin authorization gate.
import { json } from "./auth.js";
import { testConfig, seasonTypeFor, weekWindow } from "./nfl.js";
import {
  currentSeasonWeek,
  fetchSharpApi,
  fetchEspn,
  fetchSharpRaw,
  normalizeSharp,
} from "./odds-providers.js";
export async function oddsDiagnostics(env, url) {
  // Debug: why is the board not showing the expected week's games? Dumps the
  // decision inputs + each live source's outcome, so we can see (in the real CF
  // env) whether the ESPN preseason fallback is throwing.
  if (url.searchParams.get("debug") === "why") {
    const out = { now: new Date().toISOString() };
    try {
      out.testConfig = testConfig(env);
    } catch (e) {
      out.testConfig_err = String((e && e.message) || e);
    }
    try {
      out.currentSeasonWeek = currentSeasonWeek(env);
    } catch (e) {
      out.csw_err = String((e && e.message) || e);
    }
    try {
      out.seasonType = seasonTypeFor(env);
    } catch (e) {
      out.st_err = String((e && e.message) || e);
    }
    try {
      out.weekWindow = weekWindow(currentSeasonWeek(env).week, env);
    } catch (e) {
      out.ww_err = String((e && e.message) || e);
    }
    try {
      const p = await fetchSharpApi(env);
      out.sharp = {
        ok: true,
        games: (p.games || []).length,
        first: (p.games || [])[0],
      };
    } catch (e) {
      out.sharp = { ok: false, error: String((e && e.message) || e) };
    }
    try {
      const p = await fetchEspn(env);
      out.espn = {
        ok: true,
        source: p.source,
        games: (p.games || []).length,
        first: (p.games || [])[0],
      };
    } catch (e) {
      out.espn = { ok: false, error: String((e && e.message) || e) };
    }
    return json(out, { headers: { "Cache-Control": "no-store" } });
  }

  // Debug: does SharpAPI actually carry preseason (August) games, and under what
  // market/date? Dumps a date histogram + market_types for both the default
  // (market=spread,total) fetch and an unfiltered fetch, plus how many parsed
  // games land in the current pick-week window.
  if (url.searchParams.get("debug") === "sharpdates") {
    if (!env.SHARPAPI_KEY)
      return json(
        { error: "no-sharpapi-key" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    const summarize = (rows) => {
      const dateHist = {},
        marketByMonth = {};
      let minDate = null,
        maxDate = null;
      for (const r of rows) {
        const t =
          r.event_start_time ?? r.start_time ?? r.commence_time ?? r.kickoff;
        const d = String(t || "").slice(0, 10);
        if (!d) continue;
        dateHist[d] = (dateHist[d] || 0) + 1;
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
        const mon = d.slice(0, 7),
          mk = String(r.market_type ?? r.market ?? "?");
        (marketByMonth[mon] || (marketByMonth[mon] = {}))[mk] =
          (marketByMonth[mon][mk] || 0) + 1;
      }
      return {
        count: rows.length,
        minDate,
        maxDate,
        marketByMonth,
        augDates: Object.keys(dateHist)
          .filter((d) => d < "2026-09")
          .sort(),
      };
    };
    try {
      const win = weekWindow(currentSeasonWeek(env).week, env);
      const from = Date.parse(win.from),
        to = Date.parse(win.to);
      // Single unfiltered fetch (stays under SharpAPI's 12 req/min): shows ALL
      // games' dates + market_types, so we can see if August preseason games
      // exist at all and under what market.
      const allm = await fetchSharpRaw(env, 12, { market: undefined });
      const parsed = normalizeSharp(allm);
      const inWin = parsed.filter((g) => {
        const t = Date.parse(g.kickoff);
        return t >= from && t < to;
      });
      return json(
        {
          window: win,
          unfiltered: summarize(allm),
          parsedGames: parsed.length,
          parsedInWindow: inWin.length,
          parsedInWindowSample: inWin
            .slice(0, 6)
            .map((g) => ({
              away: g.away,
              home: g.home,
              kickoff: g.kickoff,
              books: Object.keys(g.books || {}),
            })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return json(
        { error: String((e && e.message) || e) },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // Debug: inspect a raw SharpAPI sample to finalize the field mapping.
  if (url.searchParams.get("debug") === "sharp") {
    if (!env.SHARPAPI_KEY)
      return json(
        { error: "no-sharpapi-key" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    try {
      const raw = await fetchSharpRaw(env);
      const team = url.searchParams.get("team")?.toLowerCase();
      const selected = team
        ? raw.filter((r) =>
            `${r.away_team} ${r.home_team}`.toLowerCase().includes(team),
          )
        : raw;
      return json(
        {
          count: raw.length,
          sample: selected.slice(0, team ? 40 : 8),
          parsedGames: normalizeSharp(selected).slice(0, 2),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return json(
        { error: String((e && e.message) || e) },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // Debug: probe SharpAPI's player-prop coverage + row schema so we can build the
  // structured Super Lock. Flexible so we can try market strings without a redeploy:
  //   ?debug=props                 -> ask for market=player_props
  //   ?debug=props&market=<value>  -> override the market param
  //   ?debug=props&nomarket=1      -> omit the market filter entirely (get all)
  if (url.searchParams.get("debug") === "props") {
    if (!env.SHARPAPI_KEY)
      return json(
        { error: "no-sharpapi-key" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    try {
      const overrides =
        url.searchParams.get("nomarket") === "1"
          ? { market: undefined }
          : { market: url.searchParams.get("market") || "player_props" };
      const raw = await fetchSharpRaw(env, 3, overrides);
      // Summarize what came back: distinct market fields + which rows are props.
      const marketVals = {},
        typeVals = {};
      let propCount = 0;
      const propSamples = [];
      for (const r of raw) {
        const mk = String(r.market ?? "");
        const mt = String(r.market_type ?? "");
        if (mk) marketVals[mk] = (marketVals[mk] || 0) + 1;
        if (mt) typeVals[mt] = (typeVals[mt] || 0) + 1;
        if (
          r.is_player_prop === true ||
          /player|prop/i.test(mt) ||
          /player|prop/i.test(mk)
        ) {
          propCount++;
          if (propSamples.length < 10) propSamples.push(r);
        }
      }
      return json(
        {
          requested: overrides,
          count: raw.length,
          propCount,
          distinctMarket: marketVals,
          distinctMarketType: typeVals,
          propSamples,
          firstRows: raw.slice(0, 3),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return json(
        { error: String((e && e.message) || e) },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  return null;
}
