// Client-render smoke: loads the real index.html in a headless browser, injects
// simulated data, and drives the Super Lock picker / War Room / locked card across
// desktop + mobile widths — catching the class of bugs that don't show up in the
// logic layer (JS errors on a data shape, layout overflow, sticky/scroll issues).
// Needs Playwright; an explicitly requested render layer fails if it cannot run.
import { suite } from "./assert.mjs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeSharpProps } from "../functions/_shared/props.js";
import { menuForGame } from "../functions/api/props.js";
import { sharpPropRows } from "./fixtures.mjs";

async function chromium() {
  try { return (await import("playwright")).chromium; } catch {}
  try { // fall back to a global install (npm i -g playwright)
    const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return (await import(pathToFileURL(root + "/playwright/index.js").href)).default.chromium;
  } catch {}
  throw new Error("Playwright not available (npm i -D playwright && npx playwright install chromium)");
}

const INDEX = pathToFileURL(new URL("../public/index.html", import.meta.url).pathname).href;

export async function run() {
  const s = suite("render — client smoke (picker · war room · locked card · layout)");
  const markets = menuForGame(normalizeSharpProps(sharpPropRows()), "New England Patriots", "Seattle Seahawks");
  const browser = await (await chromium()).launch();
  try {
    for (const vw of [1280, 1024, 390]) {
      const page = await browser.newPage({ viewport: { width: vw, height: 860 } });
      const errors = [];
      page.on("pageerror", e => errors.push(String(e.message || e)));
      await page.goto(INDEX, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(120);
      const r = await page.evaluate(async (mk) => {
        const out = { err: null, checks: {} };
        try {
          if (!state) state = {};
          state.user = { name: "Smoke" };
          state.thisWeekData = { games: [{ away: "New England Patriots", home: "Seattle Seahawks", kickoff: "2026-09-10T00:15Z", books: { fanduel: { spread: { fav: "Seattle Seahawks", line: -3.5, favPrice: -112, dogPrice: -108 }, total: { point: 44.5, overPrice: -110, underPrice: -110 } } } }] };
          slMarkets = mk; slGameKey = "New England Patriots@Seattle Seahawks";
          // Render the picker for EVERY market + player + a side + an alt line.
          let maxOverflow = 0;
          for (const m of mk) for (const pl of m.players) {
            for (const side of (m.kind === "yes" ? [""] : ["over", "under"])) {
              slDraft = { market: m.market, player: pl.player, side, line: null };
              const html = slMarketPickerHtml();
              if (typeof html !== "string" || !html) throw new Error("empty picker html for " + m.market);
            }
            if (pl.alts && pl.alts.length) { slDraft = { market: m.market, player: pl.player, side: "over", line: pl.alts[0].line }; slMarketPickerHtml(); }
          }
          // Mount one and measure horizontal overflow in the narrow sidebar.
          slDraft = { market: "receptions", player: "Cooper Kupp", side: "over", line: null };
          document.body.innerHTML = `<div style="margin-left:${innerWidth >= 1024 ? 256 : 0}px;padding:24px"><div class="grid grid-cols-1 lg:grid-cols-12 gap-6"><aside id="a" class="picks-aside lg:col-span-4 self-start"><div class="glass-card p-5"><div id="c">${superLockEditorHtml()}</div></div></aside></div></div>`;
          if (typeof bindSuperLockEditor === "function") { const el = document.getElementById("c"); el.id = "my-card-sl"; bindSuperLockEditor(); el.id = "c"; }
          const card = document.querySelector(".glass-card");
          out.checks.cardNoHOverflow = card.scrollWidth <= card.clientWidth + 1;
          const price = document.querySelector(".sl-side-price");
          out.checks.priceOneLine = price ? price.offsetHeight <= parseFloat(getComputedStyle(price).fontSize) * 1.6 : true;
          // War Room chip carries the Super Lock odds; a Favorite chip does not.
          const wr = wrChip({ bet_type: "Super Lock", kind: "pick", pick_text: "Cooper Kupp o3.5 rec", price: 280, book: "fanduel", game_key: "x@y", status: "pending", final: false, kickoff: "2026-09-10T00:15Z" }, { member_id: 1 });
          out.checks.wrOdds = /wr-odds[^>]*>\+280</.test(wr);
          // Locked card shows odds.
          currentMyPicks["Super Lock"] = { pick_text: "Cooper Kupp o3.5 rec", prop: { market: "receptions", player: "Cooper Kupp", line: 3.5, side: "over", price: 280, book: "fanduel" }, price: 280, book: "fanduel", locked_at: new Date().toISOString() };
          out.checks.lockedOdds = /lp-odds[^>]*>\+280</.test(superLockEditorHtml());
          // A long locked game-total slot must show its O/U number (not clip it).
          currentMyPicks["Over"] = { pick_text: "New Orleans Saints / Detroit Lions O49.5", book: "draftkings", locked_at: new Date().toISOString() };
          document.body.insertAdjacentHTML("beforeend", `<div id="mcb" style="width:230px">${renderMyCardBody()}</div>`);
          const ov = [...document.querySelectorAll("#mcb .slot-val")].find(v => /New Orleans/.test(v.textContent));
          out.checks.overSlotShowsLine = !!ov && /O49\.5/.test(ov.textContent) && getComputedStyle(ov).whiteSpace !== "nowrap";
          const score = { away: { score: 14 }, home: { score: 17 }, state: "in" };
          out.checks.livePush = /on the number/.test(wrPickTrack({bet_type:"Over",pick_text:"NE / SEA O31"}, score));
          out.checks.finalPush = /push/.test(wrPickTrack({bet_type:"Over",pick_text:"NE / SEA O31"}, {...score,state:"post"}));
          const prop = {prop:{market:"receptions",player:"Cooper Kupp",side:"over",line:3.5}};
          const progress = {...score,players:[{name:"Cooper Kupp",markets:{receptions:{actual:3,unit:"rec"}}}]};
          out.checks.propProgress = /3 rec.*needs 1 more/.test(wrPropTrack(prop,progress));
          out.checks.propMissing = /not available/.test(wrPropTrack(prop,score));
          out.checks.sourceAge = /Delayed.*10 min/.test(sourceAgeLabel(new Date(Date.now()-600000).toISOString()));
          document.body.innerHTML = '<main id="root"></main>';
          state.view = "warroom";
          state.warRoom = {week:1,revealed:true,anyLive:true,source_updated_at:new Date(Date.now()-600000).toISOString(),members:[{member_id:1,name:"Smoke",live:{W:0,L:0,P:0,pending:1},picks:[]}]};
          rerenderWarRoom();
          const refresh = document.getElementById("wr-refresh"); refresh.focus();
          state.warRoom.fetched_at = new Date().toISOString(); rerenderWarRoom();
          out.checks.noTimestampRerender = refresh === document.getElementById("wr-refresh");
          state.warRoom.members[0].name = "Updated"; rerenderWarRoom();
          out.checks.refreshFocus = document.activeElement.id === "wr-refresh";
          const originalFetch = window.fetch;
          window.fetch = async () => { throw new Error("offline"); };
          await loadWarRoom();
          out.checks.keepLastGood = state.warRoom.members[0].name === "Updated" && state.warRoom.stale;
          rerenderWarRoom();
          const retry = document.getElementById("wr-refresh"); await retry.onclick();
          out.checks.refreshReenabled = !document.getElementById("wr-refresh").disabled;
          window.fetch = originalFetch;
          out.checks.liveNoOverflow = document.getElementById("root").scrollWidth <= innerWidth;
          // An actively focused card defers a changed line, then catches up on
          // the next response even if the provider line has stopped moving.
          state.view = "thisweek";
          const old = structuredClone(state.thisWeekData), next = structuredClone(old);
          const game = next.games[0], key = gameKeyOf(game);
          game.books.fanduel.spread.line = -5.5;
          const host = document.getElementById("root");
          host.innerHTML = `<div class="game-card" data-game-key="${key}" data-book="fanduel"><button id="active-line">old line</button></div>`;
          document.getElementById("active-line").focus();
          applyLiveOdds(old,next);
          out.checks.deferActive = !!document.getElementById("active-line");
          document.activeElement.blur();
          applyLiveOdds(next,structuredClone(next));
          out.checks.deferredCatchesUp = !document.getElementById("active-line") && host.textContent.includes("5.5");
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
      }, markets);

      s.ok(`[${vw}px] no page errors`, errors.length === 0, errors.join(" | "));
      s.ok(`[${vw}px] picker rendered all markets without throwing`, !r.err, r.err);
      s.ok(`[${vw}px] card has no horizontal overflow`, r.checks.cardNoHOverflow !== false);
      s.ok(`[${vw}px] O/U price stays on one line`, r.checks.priceOneLine !== false);
      s.ok(`[${vw}px] War Room Super Lock chip shows odds`, r.checks.wrOdds === true);
      s.ok(`[${vw}px] locked Super Lock card shows odds`, r.checks.lockedOdds === true);
      s.ok(`[${vw}px] locked Over/Under slot shows its line, not truncated`, r.checks.overSlotShowsLine === true);
      for (const key of ["livePush","finalPush","propProgress","propMissing","sourceAge","noTimestampRerender","refreshFocus","liveNoOverflow","deferActive","deferredCatchesUp","keepLastGood","refreshReenabled"]) s.ok(`[${vw}px] ${key}`, r.checks[key] === true);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return s;
}
