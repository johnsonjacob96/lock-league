// Super Lock panel: state, rendering, selection and saving.
// Loaded before the app; functions resolve app helpers when called.
const superLockState = {
  mode: "board",
  gameKey: "",
  markets: null,
  loading: false,
  draft: { market: "", player: "", side: "", book: "", line: null },
  editing: false,
  photoIndex: null,
  photoRequest: null,
  open: false,
  search: "",
  tab: "props",
  saving: false,
};

// Super Lock entry + grade live in My Card (no separate picks tab). Kept out of
// #my-card-body so a live-odds refresh can't clobber a half-typed entry.
// Two modes: "board" picks a structured player prop off the live board (it
// auto-grades off the box score); "custom" is the old free-text bet (manual
// Hit/Miss/Push) for anything the books don't post.

function slMeta(p) {
  return (p && (p.prop_meta || p.prop)) || null;
}
const fmtPrice = (p) => (p == null ? "—" : americanOdds(p));
const slShort = (n) =>
  String(n || "")
    .split(" ")
    .slice(-1)[0];

// Every selectable side carries its own sportsbook line and price.
const SL_BOOKS = ["fanduel", "draftkings"];
function slBookSide(pl, book, side) {
  const b = pl && pl[book];
  return b && b[side] != null ? { book, price: b[side], line: b.line } : null;
}
function slBookAlt(pl, book, line) {
  const a = (pl.alts || []).find((x) => Number(x.line) === Number(line));
  return a && a[book] != null
    ? { book, price: a[book], line: Number(line) }
    : null;
}
// Representative line for sorting a market highest-first: the largest line shown
// across the books (so "highest numbers first" ranks by the biggest visible line).
function slPropLine(pl) {
  const lines = [];
  for (const bk of SL_BOOKS) {
    const b = pl[bk];
    if (b && typeof b.line === "number" && Number.isFinite(b.line))
      lines.push(b.line);
  }
  if (typeof pl.line === "number" && Number.isFinite(pl.line))
    lines.push(pl.line);
  return lines.length ? Math.max(...lines) : -Infinity;
}
// Resolve the current draft selection (main O/U, an alt buy-up line, or anytime
// TD) into a single {side, line, price, book, label}. Single source of truth for
// the side buttons' active state, the lock button, and the lock request. Reads the
// drafted book only — line and odds always come from the same book.
function slPropSel(m, pl) {
  if (m.kind === "yes") {
    const b = slBookSide(pl, superLockState.draft.book, "yes");
    if (!b) return null;
    return {
      side: "yes",
      line: null,
      price: b.price,
      book: b.book,
      label: `${slShort(pl.player)} anytime TD`,
    };
  }
  if (superLockState.draft.line != null) {
    const a = slBookAlt(
      pl,
      superLockState.draft.book,
      superLockState.draft.line,
    );
    if (!a) return null;
    return {
      side: "over",
      line: Number(superLockState.draft.line),
      price: a.price,
      book: a.book,
      label: `Over ${superLockState.draft.line}`,
    };
  }
  if (
    superLockState.draft.side === "over" ||
    superLockState.draft.side === "under"
  ) {
    const b = slBookSide(
      pl,
      superLockState.draft.book,
      superLockState.draft.side,
    );
    if (!b) return null;
    return {
      side: superLockState.draft.side,
      line: b.line,
      price: b.price,
      book: b.book,
      label: `${superLockState.draft.side === "over" ? "Over" : "Under"} ${b.line}`,
    };
  }
  return null;
}

function slPlayerNameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?$/, "")
    .replace(/[^a-z0-9]/g, "");
}
function slPlayerPhoto(name) {
  const candidates =
    superLockState.photoIndex?.get(slPlayerNameKey(name)) || [];
  const g = slCurrentGame();
  const inGame = candidates.filter((p) =>
    p.teams?.some((t) => t === g?.away || t === g?.home),
  );
  const matches = inGame.length ? inGame : candidates;
  return matches.length === 1 &&
    /^https:\/\/(?:[a-z0-9-]+\.)*espncdn\.com\//i.test(matches[0].photo)
    ? matches[0].photo
    : null;
}
function slPlayerAvatarHtml(name) {
  const photo = slPlayerPhoto(name);
  return `<span class="sl-avatar" data-slportrait="${escapeHtml(name)}" aria-hidden="true"><span>${escapeHtml(
    name
      .split(" ")
      .map((x) => x[0])
      .slice(0, 2)
      .join(""),
  )}</span>${photo ? `<img src="${escapeHtml(photo)}" alt="" width="48" height="48" loading="lazy" onload="this.style.opacity=1" onerror="this.remove()">` : ""}</span>`;
}
async function loadSlPlayerPhotos() {
  if (superLockState.photoIndex) return;
  if (superLockState.photoRequest) return superLockState.photoRequest;
  superLockState.photoRequest = (async () => {
    try {
      const r = await fetch("/data/player-photos.json");
      if (!r.ok) return;
      const data = await r.json();
      if (!Array.isArray(data.players)) return;
      superLockState.photoIndex = new Map();
      for (const p of data.players) {
        const key = slPlayerNameKey(p.name);
        const group = superLockState.photoIndex.get(key) || [];
        if (!group.some((x) => x.id === p.id)) group.push(p);
        superLockState.photoIndex.set(key, group);
      }
      // Patch portraits only: loading photos must not reset a selection, scroll, or typed input.
      document
        .querySelectorAll("#sl-dialog [data-slportrait]")
        .forEach((el) => {
          el.outerHTML = slPlayerAvatarHtml(el.dataset.slportrait);
        });
    } catch {
      /* Portraits are optional; preserve the usable initials. */
    } finally {
      superLockState.photoRequest = null;
    }
  })();
  return superLockState.photoRequest;
}
function slSortGames(games) {
  return games
    .slice()
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
}
function slSortedPlayers(m) {
  const rows = m.players.map((pl, pi) => ({ pl, pi }));
  // Sort every over/under market highest-line-first (yards, receptions,
  // attempts, completions, TDs, …). Anytime TD has no line, so it keeps its
  // board order (best odds first).
  if (m.kind === "yes") return rows;
  const line = (pl) => slPropLine(pl);
  return rows.sort((a, b) =>
    line(a.pl) === line(b.pl) ? a.pi - b.pi : line(b.pl) - line(a.pl),
  );
}
function superLockEditorHtml() {
  const p = currentMyPicks["Super Lock"];
  return (
    `<div class="sl-entry"><strong>SUPER LOCK</strong><span class="sl-hint">Odds must be -120 or longer</span></div>` +
    (p && (p.pick_text || p.text)
      ? slLockedHtml(p)
      : `<button class="sl-launch" id="sl-open">Choose your Super Lock <span>→</span></button>`) +
    `<span id="mycard-sl-msg" role="status"></span>`
  );
}
function closeSlPanel() {
  if (superLockState.saving) return;
  superLockState.open = false;
  superLockState.editing = false;
  const dialog = document.getElementById("sl-dialog");
  if (dialog) {
    dialog.close();
    dialog.remove();
  }
  const entry = document.getElementById("my-card-sl");
  if (entry) {
    entry.innerHTML = superLockEditorHtml();
    bindSuperLockEditor();
  }
  document.getElementById("sl-open")?.focus();
  document.getElementById("sl-repick")?.focus();
}
function openSlPanel() {
  void loadSlPlayerPhotos();
  superLockState.open = true;
  superLockState.editing = true;
  refreshSuperLockEditor();
}
function slPanelHtml() {
  return `<div class="sl-panel-head"><button id="sl-back" aria-label="Back to games">←</button><h2>SUPER LOCK</h2><button id="sl-close" aria-label="Close Super Lock">×</button></div>
    <div class="sl-panel-body">${superLockState.mode === "custom" ? `<h3>Custom pick</h3>${slCustomHtml(currentMyPicks["Super Lock"])}` : slBoardPickerHtml()}
    <div id="mycard-sl-msg" role="status" class="sl-hint"></div></div>`;
}

function slLockedHtml(p) {
  const meta = slMeta(p);
  const txt = escapeHtml(p.pick_text || p.text);
  const res = p.result || "";
  const resBadge = res
    ? `<span class="sl-res ${res}">${res === "W" ? "HIT" : res === "L" ? "MISS" : "PUSH"}</span>`
    : "";
  const lockedTs = p.locked_at
    ? `<span class="lp-ts">Locked ${fmtLockedAt(p.locked_at)}</span>`
    : "";
  const repick = `<div class="mt-2"><button class="sl-link" id="sl-repick">Change pick</button></div>`;
  if (meta) {
    // The odds are a core piece of the Super Lock (prop prices swing widely), so
    // show the locked price — the longest-odds book we locked against. Prefer the
    // top-level column, fall back to the price stamped in prop_meta.
    const price =
      p.price != null ? p.price : meta.price != null ? meta.price : null;
    const odds =
      price != null ? `<span class="lp-odds">${fmtPrice(price)}</span>` : "";
    const book = meta.book
      ? `<span class="lp-book">${bookLabel(meta.book)}</span>`
      : "";
    return `
      <div class="sl-locked">
        <div class="flex items-center justify-between gap-2">
          <span class="sl-locked-txt">${txt}</span>${resBadge}
        </div>
        <div class="lp-meta">${odds}${book}${lockedTs}</div>
        <div class="sl-auto"><span class="material-symbols-outlined text-[12px]" style="font-variation-settings:'FILL' 1">bolt</span>${res ? "Auto-graded from box score" : "Auto-grades after the game"}</div>
      </div>${repick}`;
  }
  // Free-text: manual Hit/Miss/Push.
  const markHtml = `
    <div class="flex flex-wrap items-center gap-2 mt-3">
      <span class="font-data-tabular text-[10px] tracking-widest text-on-surface-variant uppercase mr-1">Grade</span>
      <button class="sl-mark-btn W ${res === "W" ? "current" : ""}" data-result="W">Hit · W</button>
      <button class="sl-mark-btn L ${res === "L" ? "current" : ""}" data-result="L">Miss · L</button>
      <button class="sl-mark-btn P ${res === "P" ? "current" : ""}" data-result="P">Push · P</button>
    </div>`;
  return `<div class="sl-locked"><span class="sl-locked-txt">${txt}</span>${p.price != null ? `<span class="lp-odds">${fmtPrice(p.price)}</span>` : `<span class="sl-hint">Saved odds missing · excluded from units</span>`}${lockedTs ? `<div class="lp-meta">${lockedTs}</div>` : ""}</div>${markHtml}${repick}`;
}

function slCustomHtml(p) {
  const txt =
    p && (p.pick_text || p.text) && !slMeta(p)
      ? escapeHtml(p.pick_text || p.text)
      : "";
  return `
    <label for="mycard-superlock" class="sl-search-label">Your pick</label><div class="flex gap-2">
      <input class="pick-input flex-1" id="mycard-superlock" autocapitalize="none" value="${txt}" placeholder="Player prop / specialty bet">
      <button class="btn-primary" id="mycard-sl-save">Save</button>
    </div>
    <label class="sl-hint block mt-2" for="mycard-sl-price">American odds (required, e.g. -110 or +200)</label>
    <input class="pick-input w-full mt-1" id="mycard-sl-price" type="number" step="1" value="${p?.price != null ? escapeHtml(String(p.price)) : ""}" placeholder="Enter the book’s odds">
    <div class="sl-hint mt-2">Custom odds are self-reported; graded by hand (Hit/Miss/Push). Units use the odds saved here.</div>`;
}

function slCurrentGame() {
  return (
    ((state.thisWeekData && state.thisWeekData.games) || []).find(
      (g) => `${g.away}@${g.home}` === superLockState.gameKey,
    ) || null
  );
}
// Best-priced side of a game LINE (spread/total) across FD+DK, mirroring the
// board's Fav/Dog/Over/Under buttons. Returns the side + line + text the server
// re-derives against, or null if the game doesn't offer that market.
function slGameLineSide(g, bet) {
  const books = g.books || {};
  const cands = [];
  for (const bk of ["fanduel", "draftkings"]) {
    const b = books[bk];
    if (!b) continue;
    if (bet === "Favorite" && b.spread)
      cands.push({
        book: bk,
        side: "fav",
        line: b.spread.line,
        price: b.spread.favPrice,
        text: `${b.spread.fav} ${b.spread.line}`,
        label: `${slShort(b.spread.fav)} ${b.spread.line}`,
      });
    else if (bet === "Dog" && b.spread) {
      const dog = b.spread.fav === g.home ? g.away : g.home;
      const dl = Math.abs(b.spread.line);
      cands.push({
        book: bk,
        side: "dog",
        line: b.spread.line,
        price: b.spread.dogPrice,
        text: `${dog} +${dl}`,
        label: `${slShort(dog)} +${dl}`,
      });
    } else if (bet === "Over" && b.total)
      cands.push({
        book: bk,
        side: "over",
        line: b.total.point,
        price: b.total.overPrice,
        text: `${g.away} / ${g.home} O${b.total.point}`,
        label: `Over ${b.total.point}`,
      });
    else if (bet === "Under" && b.total)
      cands.push({
        book: bk,
        side: "under",
        line: b.total.point,
        price: b.total.underPrice,
        text: `${g.away} / ${g.home} U${b.total.point}`,
        label: `Under ${b.total.point}`,
      });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (b.price ?? -1e9) - (a.price ?? -1e9)); // best payout first, same as props
  return cands[0];
}
const BET_FOR_SIDE = {
  fav: "Favorite",
  dog: "Dog",
  over: "Over",
  under: "Under",
};

function slBoardPickerHtml() {
  if (!superLockState.gameKey) {
    const games = slSortGames(state.thisWeekData?.games || []);
    return `<h3>Choose your game</h3><p class="sl-hint">Games in kickoff order · Odds -120 or longer</p><div class="sl-game-list">${
      games
        .map((g) => {
          const started = new Date(g.kickoff).getTime() <= Date.now();
          return `<button class="sl-game-choice" data-slgame="${escapeHtml(g.away + "@" + g.home)}" ${started ? "disabled" : ""}>
        <span class="sl-matchup"><span>${teamLogoMark(g.away, "w-8 h-8", "text-xs")}<b>${escapeHtml(slShort(g.away))}</b></span><small>@</small><span>${teamLogoMark(g.home, "w-8 h-8", "text-xs")}<b>${escapeHtml(slShort(g.home))}</b></span></span>
        <small>${started ? "Game started" : escapeHtml(new Date(g.kickoff).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" }))}</small></button>`;
        })
        .join("") || "<p>No games available for this week.</p>"
    }</div><button class="sl-link sl-custom-link" data-slmode="custom">Enter a custom pick instead</button>`;
  }
  const g = slCurrentGame();
  return `<div class="sl-selected-game">${g ? `<span>${teamLogoMark(g.away, "w-8 h-8", "text-xs")}<span><strong>${teamShort(g.away)}</strong><small>${escapeHtml(teamNick(g.away))}</small></span></span><small>vs</small><span>${teamLogoMark(g.home, "w-8 h-8", "text-xs")}<span><strong>${teamShort(g.home)}</strong><small>${escapeHtml(teamNick(g.home))}</small></span></span>` : escapeHtml(superLockState.gameKey)}</div>
    <button class="sl-link" id="sl-change-game">Change game</button>
    <div class="sl-tabs"><button data-sltab="props" aria-pressed="${superLockState.tab === "props"}">Player props</button><button data-sltab="lines" aria-pressed="${superLockState.tab === "lines"}">Game lines</button></div>
    ${superLockState.tab === "lines" ? `<div class="sl-filters"><button data-slmarket="__spread__">Spread</button><button data-slmarket="__total__">Total</button></div>${superLockState.draft.market.startsWith("__") && g ? slGameLineSubHtml(g, superLockState.draft.market === "__spread__" ? "spread" : "total") : '<p class="sl-hint">Choose spread or total.</p>'}` : superLockState.loading ? '<p role="status">Loading player props…</p>' : slBrowsePropsHtml()}
    <button class="sl-link sl-custom-link" data-slmode="custom">Enter a custom pick instead</button>`;
}
function slBrowsePropsHtml() {
  const markets = superLockState.markets || [];
  if (!markets.length)
    return `<p class="sl-hint">No player props available right now. Try game lines or refresh.</p><button id="sl-retry" class="sl-link">Refresh props</button>`;
  const selectedMarket = superLockState.draft.market.startsWith("__")
    ? ""
    : superLockState.draft.market;
  const rows = markets.flatMap((m, mi) =>
    selectedMarket && selectedMarket !== m.market
      ? []
      : slSortedPlayers(m).map(({ pl, pi }) => {
          const selected =
            superLockState.draft.market === m.market &&
            superLockState.draft.player === pl.player;
          const sideList = m.kind === "yes" ? ["yes"] : ["over", "under"];
          // One row per book, each showing that book's OWN line + odds. Books are never
          // combined, so the line you lock always matches the odds beside it.
          const books = SL_BOOKS.filter((bk) =>
            sideList.some((sd) => slBookSide(pl, bk, sd)),
          );
          return `<article class="sl-prop-row" data-player-search="${escapeHtml(pl.player.toLowerCase())}"><div class="sl-player-heading">${slPlayerAvatarHtml(pl.player)}<div><strong>${escapeHtml(pl.player)}</strong><small>${escapeHtml(m.label)}</small></div></div>
      <div class="sl-books">${books
        .map(
          (bk) =>
            `<div class="sl-book-row"><span class="sl-book-tag">${bookShort(bk)}</span><div class="sl-sides">${sideList
              .map((side) => {
                const info = slBookSide(pl, bk, side);
                if (!info)
                  return `<span class="sl-side-btn sl-side-empty" aria-hidden="true"></span>`;
                const active =
                  selected &&
                  superLockState.draft.book === bk &&
                  superLockState.draft.side === side &&
                  superLockState.draft.line == null;
                return `<button class="sl-side-btn ${active ? "active" : ""}" data-slchoose="${mi}:${pi}:${side}:${bk}" aria-pressed="${active}"><span class="sl-side-lab">${side === "yes" ? "Anytime TD" : (side === "over" ? "Over " : "Under ") + info.line}</span><span class="sl-side-price">${fmtPrice(info.price)}</span></button>`;
              })
              .join("")}</div></div>`,
        )
        .join("")}</div>
      ${
        pl.alts?.length
          ? `<details class="sl-alt-wrap"><summary>Alternate lines</summary><div class="sl-alts">${pl.alts
              .flatMap((alt) =>
                SL_BOOKS.map((bk) => {
                  const a = slBookAlt(pl, bk, alt.line);
                  return !a
                    ? ""
                    : `<button class="sl-alt-btn ${selected && superLockState.draft.book === bk && Number(superLockState.draft.line) === Number(alt.line) ? "active" : ""}" data-slchoose="${mi}:${pi}:over:${bk}:${alt.line}">Over ${alt.line}<span>${fmtPrice(a.price)} · ${bookShort(bk)}</span></button>`;
                }),
              )
              .join("")}</div></details>`
          : ""
      }</article>`;
        }),
  );
  const m = markets.find((x) => x.market === superLockState.draft.market),
    pl = m?.players.find((x) => x.player === superLockState.draft.player);
  return `<label class="sl-search-label" for="sl-search">Find a player</label><input id="sl-search" class="pick-input" type="search" value="${escapeHtml(superLockState.search)}" placeholder="Search player name">
    <div class="sl-filters"><button data-slmarket="" aria-pressed="${!selectedMarket}">All props</button>${markets.map((m) => `<button data-slmarket="${escapeHtml(m.market)}" aria-pressed="${selectedMarket === m.market}">${escapeHtml(m.label)}</button>`).join("")}</div>
    <div class="sl-prop-list">${rows.join("")}</div><p id="sl-no-results" hidden>No players match your search.</p>
    ${m && pl && slPropSel(m, pl) ? `<div class="sl-confirm"><small>YOUR SUPER LOCK</small><strong>${escapeHtml(pl.player)} · ${escapeHtml(m.label)}</strong>${slLockBtnHtml(m, pl)}<small>Auto-graded after the game</small></div>` : ""}`;
}

// Sub-picker for a game-line Super Lock (spread or total): two side buttons +
// a lock button, reusing the prop picker's .sl-sides styling.
function slGameLineSubHtml(g, kind) {
  const sides = kind === "spread" ? ["fav", "dog"] : ["over", "under"];
  const btns = sides
    .map((sd) => {
      const info = slGameLineSide(g, BET_FOR_SIDE[sd]);
      if (!info) return "";
      return `<button class="sl-side-btn ${superLockState.draft.side === sd ? "active" : ""}" data-slside="${sd}">
      <span class="sl-side-lab">${escapeHtml(info.label)}</span>
      <span class="sl-side-price">${fmtPrice(info.price)}${info.book ? " · " + bookShort(info.book) : ""}</span></button>`;
    })
    .join("");
  let out = `<div class="sl-sides mt-2">${btns}</div>`;
  if (sides.includes(superLockState.draft.side)) {
    const info = slGameLineSide(g, BET_FOR_SIDE[superLockState.draft.side]);
    if (info) {
      const meets = info.price != null && Number(info.price) >= -120;
      const warn =
        info.price != null && !meets
          ? `<div class="sl-hint warn mt-1">${fmtPrice(info.price)} is shorter than -120 — a Super Lock must be -120 or longer.</div>`
          : info.price == null
            ? `<div class="sl-hint warn mt-1">No price available for this side.</div>`
            : "";
      const dis = meets ? "" : `disabled style="opacity:.5;cursor:not-allowed"`;
      out += `<button class="btn-primary w-full mt-2" id="sl-lock-line" ${dis}>Lock ${escapeHtml(info.label)} · ${fmtPrice(info.price)}</button>${warn}`;
    }
  }
  return out;
}

function slLockBtnHtml(m, pl) {
  const sel = slPropSel(m, pl);
  if (!sel) return "";
  const meets =
    Number.isInteger(Number(sel.price)) &&
    Math.abs(Number(sel.price)) >= 100 &&
    Number(sel.price) >= -120;
  const warn =
    sel.price != null && !meets
      ? `<div class="sl-hint warn mt-1">${fmtPrice(sel.price)} is shorter than -120 — a Super Lock must be -120 or longer.</div>`
      : sel.price == null
        ? `<div class="sl-hint warn mt-1">No price available for this line.</div>`
        : "";
  const dis = meets ? "" : `disabled style="opacity:.5;cursor:not-allowed"`;
  const book = sel.book ? ` · ${bookShort(sel.book)}` : "";
  if (superLockState.open)
    return `<span class="sl-selection-line">${escapeHtml(sel.label)} · ${fmtPrice(sel.price)}${sel.book ? " · " + bookLabel(sel.book) : ""}</span><button class="btn-primary w-full mt-2" id="sl-lock" ${dis}>Lock Super Lock</button>${warn}`;
  return `<button class="btn-primary w-full mt-2" id="sl-lock" ${dis}>Lock Super Lock · ${escapeHtml(sel.label)} · ${fmtPrice(sel.price)}${book}</button>${warn}`;
}

function bindSuperLockEditor() {
  const root =
    document.getElementById("sl-dialog") ||
    document.getElementById("my-card-sl");
  if (!root) return;
  bindSlPanelControls(root);
  // Custom free-text save + manual grade.
  const save = document.getElementById("mycard-sl-save");
  if (save)
    save.onclick = () => {
      const inp = document.getElementById("mycard-superlock");
      submitSl(() => saveSuperLockText(inp ? inp.value : ""));
    };
  root
    .querySelectorAll(".sl-mark-btn")
    .forEach((b) => (b.onclick = () => markSuperLockMyCard(b.dataset.result)));
  // Change an already-locked pick.
  const repick = document.getElementById("sl-repick");
  if (repick) repick.onclick = openSlPanel;
  root.querySelectorAll(".sl-side-btn[data-slside]").forEach(
    (b) =>
      (b.onclick = () => {
        superLockState.draft.side = b.dataset.slside;
        superLockState.draft.line = null;
        refreshSuperLockEditor();
      }),
  );
  const lock = document.getElementById("sl-lock");
  if (lock && !lock.disabled) lock.onclick = () => submitSl(lockStructuredProp);
  const lockLine = document.getElementById("sl-lock-line");
  if (lockLine && !lockLine.disabled)
    lockLine.onclick = () => submitSl(lockGameLine);
}
async function submitSl(action) {
  if (superLockState.saving) return;
  superLockState.saving = true;
  const dialog = document.getElementById("sl-dialog");
  dialog?.setAttribute("aria-busy", "true");
  dialog?.querySelectorAll("button,input").forEach((el) => {
    el.dataset.wasDisabled = String(el.disabled);
    el.disabled = true;
  });
  try {
    await action();
  } finally {
    superLockState.saving = false;
    if (superLockState.open && !superLockState.editing) {
      closeSlPanel();
      refreshSuperLockEditor();
    } else {
      dialog?.removeAttribute("aria-busy");
      dialog?.querySelectorAll("[data-was-disabled]").forEach((el) => {
        el.disabled = el.dataset.wasDisabled === "true";
        delete el.dataset.wasDisabled;
      });
    }
  }
}
function bindSlPanelControls(root) {
  root.querySelector("#sl-open")?.addEventListener("click", openSlPanel);
  root.querySelector("#sl-close")?.addEventListener("click", closeSlPanel);
  const back = () => {
    superLockState.gameKey = "";
    superLockState.search = "";
    superLockState.mode = "board";
    superLockState.draft = {
      market: "",
      player: "",
      side: "",
      book: "",
      line: null,
    };
    refreshSuperLockEditor();
  };
  root.querySelector("#sl-back")?.addEventListener("click", back);
  root.querySelector("#sl-change-game")?.addEventListener("click", back);
  root
    .querySelector("#sl-retry")
    ?.addEventListener("click", () => loadPropMenu(superLockState.gameKey));
  root.querySelectorAll("[data-slmode]").forEach(
    (b) =>
      (b.onclick = () => {
        superLockState.mode = b.dataset.slmode;
        refreshSuperLockEditor();
      }),
  );
  root.querySelectorAll("[data-slgame]").forEach(
    (b) =>
      (b.onclick = () => {
        superLockState.gameKey = b.dataset.slgame;
        superLockState.tab = "props";
        superLockState.search = "";
        superLockState.draft = {
          market: "",
          player: "",
          side: "",
          book: "",
          line: null,
        };
        superLockState.markets = null;
        loadPropMenu(superLockState.gameKey);
      }),
  );
  root.querySelectorAll("[data-sltab]").forEach(
    (b) =>
      (b.onclick = () => {
        superLockState.tab = b.dataset.sltab;
        superLockState.draft = {
          market: "",
          player: "",
          side: "",
          book: "",
          line: null,
        };
        refreshSuperLockEditor();
      }),
  );
  root.querySelectorAll("[data-slmarket]").forEach(
    (b) =>
      (b.onclick = () => {
        superLockState.draft = {
          market: b.dataset.slmarket,
          player: "",
          side: "",
          book: "",
          line: null,
        };
        refreshSuperLockEditor();
      }),
  );
  root.querySelectorAll("[data-slchoose]").forEach(
    (b) =>
      (b.onclick = () => {
        const [mi, pi, side, book, line] = b.dataset.slchoose.split(":");
        const m = superLockState.markets[mi],
          pl = m.players[pi];
        superLockState.draft = {
          market: m.market,
          player: pl.player,
          side,
          book,
          line: line == null ? null : Number(line),
        };
        refreshSuperLockEditor();
      }),
  );
  const search = root.querySelector("#sl-search");
  const filter = () => {
    let visible = 0;
    root.querySelectorAll("[data-player-search]").forEach((row) => {
      row.hidden = !row.dataset.playerSearch.includes(
        superLockState.search.trim().toLowerCase(),
      );
      if (!row.hidden) visible++;
    });
    const empty = root.querySelector("#sl-no-results");
    if (empty) empty.hidden = visible > 0;
  };
  if (search) {
    search.oninput = () => {
      superLockState.search = search.value;
      filter();
    };
    filter();
  }
}
function refreshSuperLockEditor() {
  const el = document.getElementById("my-card-sl");
  if (!el) return;
  if (superLockState.saving) return;
  if (superLockState.open && !superLockState.editing) closeSlPanel();
  if (superLockState.open) {
    let dialog = document.getElementById("sl-dialog");
    const fresh = !dialog;
    if (fresh) {
      dialog = document.createElement("dialog");
      dialog.id = "sl-dialog";
      dialog.setAttribute("aria-label", "Choose Super Lock");
      document.body.append(dialog);
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        closeSlPanel();
      });
    }
    const customText = dialog.querySelector("#mycard-superlock")?.value;
    const customPrice = dialog.querySelector("#mycard-sl-price")?.value;
    const scroll = dialog.querySelector(".sl-panel-body")?.scrollTop || 0;
    const active = document.activeElement;
    const focusAttr = [
      "data-slchoose",
      "data-slmarket",
      "data-sltab",
      "id",
    ].find((attr) => active?.hasAttribute(attr));
    const focusValue = focusAttr ? active.getAttribute(focusAttr) : null;
    const filterScroll = dialog.querySelector(".sl-filters")?.scrollLeft || 0;
    el.querySelector("#mycard-sl-msg")?.remove();
    dialog.innerHTML = slPanelHtml();
    const confirmation = dialog.querySelector(".sl-confirm");
    if (confirmation) dialog.append(confirmation);
    if (customText != null && dialog.querySelector("#mycard-superlock"))
      dialog.querySelector("#mycard-superlock").value = customText;
    if (customPrice != null && dialog.querySelector("#mycard-sl-price"))
      dialog.querySelector("#mycard-sl-price").value = customPrice;
    if (fresh) dialog.showModal();
    bindSuperLockEditor();
    dialog.querySelector(".sl-panel-body").scrollTop = scroll;
    const filters = dialog.querySelector(".sl-filters");
    if (filters) filters.scrollLeft = filterScroll;
    if (focusAttr)
      Array.from(dialog.querySelectorAll("[" + focusAttr + "]"))
        .find((b) => b.getAttribute(focusAttr) === focusValue)
        ?.focus({ preventScroll: true });
  } else {
    el.innerHTML = superLockEditorHtml();
    bindSuperLockEditor();
  }
}

let propRefreshTimer = null;
async function loadPropMenu(gameKey) {
  clearTimeout(propRefreshTimer);
  superLockState.loading = true;
  refreshSuperLockEditor();
  let markets = [];
  try {
    const r = await fetch(
      `/api/props?game_key=${encodeURIComponent(gameKey)}`,
      { credentials: "include" },
    );
    const j = await r.json();
    markets = j && Array.isArray(j.markets) ? j.markets : [];
  } catch {
    markets = [];
  }
  if (superLockState.gameKey !== gameKey) return; // selection moved on; drop the stale response
  superLockState.markets = markets;
  superLockState.loading = false;
  refreshSuperLockEditor();
  propRefreshTimer = setTimeout(() => {
    if (!document.hidden && superLockState.open && superLockState.tab === "props" && !superLockState.saving && state.view === "thisweek" && superLockState.gameKey === gameKey && document.getElementById("mycard-sl-msg") && Date.parse(slCurrentGame()?.kickoff) > Date.now()) loadPropMenu(gameKey);
  }, 60000);
}
// Client mirror of the server's canonical prop text (functions/_shared/props.js).
function propTextClient(prop, m) {
  if (m.kind === "yes" || prop.side === "yes")
    return `${prop.player} anytime TD`;
  const dir = prop.side === "under" ? "u" : "o";
  return `${prop.player} ${dir}${prop.line} ${m.unit}`;
}
async function lockStructuredProp() {
  const m = (superLockState.markets || []).find(
    (x) => x.market === superLockState.draft.market,
  );
  const pl =
    m && m.players.find((x) => x.player === superLockState.draft.player);
  if (!m || !pl) return;
  const sel = slPropSel(m, pl);
  if (!sel) return;
  const best = { book: sel.book, price: sel.price };
  const prop = {
    market: m.market,
    player: pl.player,
    line: sel.side === "yes" ? null : sel.line,
    side: sel.side,
    book: sel.book,
    game_key: superLockState.gameKey,
  };
  const msg = document.getElementById("mycard-sl-msg");
  try {
    const r = await fetch("/api/picks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season: 2026,
        week: myCardWeek(),
        picks: [{ bet_type: "Super Lock", prop, expected_quote: {book:sel.book,line:prop.line,price:best.price} }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      if(j.error==="quote-changed" || j.error==="prop-not-offered") {
        await loadPropMenu(superLockState.gameKey);
        const note=document.getElementById("mycard-sl-msg");
        if(note)note.textContent=j.detail || "THAT LINE IS NO LONGER OFFERED · REVIEW THE REFRESHED MENU";
        return;
      }
      if (msg)
        msg.textContent =
          j.error === "locked"
            ? "LOCKED · CUTOFF PASSED"
            : j.error === "super-lock-price"
              ? "ODDS MUST BE -120 OR LONGER"
              : j.error === "prop-not-offered"
                ? "THAT LINE IS NO LONGER OFFERED"
                : j.error === "game-started"
                  ? "GAME ALREADY STARTED"
                  : j.detail || "ERROR · " + (j.error || "");
      return;
    }
    currentMyPicks["Super Lock"] = j.picks?.find(
      (p) => p.bet_type === "Super Lock",
    ) || {
      pick_text: propTextClient(prop, m),
      prop,
      book: best.book,
      price: best.price,
      locked_at: new Date().toISOString(),
    };
    superLockState.editing = false;
    superLockState.draft = {
      market: "",
      player: "",
      side: "",
      book: "",
      line: null,
    };
    showToast("SUPER LOCK LOCKED");
    refreshMyCard();
    refreshSuperLockEditor();
  } catch {
    if (msg) msg.textContent = "NETWORK ERROR";
  }
}
async function lockGameLine() {
  const g = slCurrentGame();
  const bet = BET_FOR_SIDE[superLockState.draft.side];
  if (!g || !bet) return;
  const info = slGameLineSide(g, bet);
  if (!info) return;
  const line_pick = {
    game_key: superLockState.gameKey,
    bet,
    side: info.side,
    book: info.book,
    line: info.line,
    price: info.price,
    pick_text: info.text,
  };
  const msg = document.getElementById("mycard-sl-msg");
  try {
    const r = await fetch("/api/picks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season: 2026,
        week: myCardWeek(),
        picks: [{ bet_type: "Super Lock", line_pick, expected_quote: {book:info.book,line:info.line,price:info.price} }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      if (j.error === "quote-changed") {
        const fresh = await fetch("/api/odds", {credentials:"include"});
        if (fresh.ok) applyLiveOdds(state.thisWeekData, await fresh.json(), true);
        refreshSuperLockEditor();
        const note = document.getElementById("mycard-sl-msg");
        if (note) note.textContent = j.detail;
        return;
      }
      if (msg)
        msg.textContent =
          j.error === "locked"
            ? "LOCKED · CUTOFF PASSED"
            : j.error === "super-lock-price"
              ? "ODDS MUST BE -120 OR LONGER"
              : j.error === "line-not-offered"
                ? "THAT LINE IS NO LONGER OFFERED"
                : j.error === "game-not-on-board"
                  ? "GAME NOT ON THE BOARD"
                  : j.error === "game-started"
                    ? "GAME ALREADY STARTED"
                    : j.detail || "ERROR · " + (j.error || "");
      return;
    }
    const meta = {
      kind: bet === "Over" || bet === "Under" ? "total" : "spread",
      bet,
      side: info.side,
      line: info.line,
      book: info.book,
      price: info.price,
      game_key: superLockState.gameKey,
    };
    currentMyPicks["Super Lock"] = j.picks?.find(
      (p) => p.bet_type === "Super Lock",
    ) || {
      pick_text: info.text,
      prop: meta,
      book: info.book,
      price: info.price,
      locked_at: new Date().toISOString(),
    };
    superLockState.editing = false;
    superLockState.draft = { market: "", player: "", side: "", book: "" };
    showToast("SUPER LOCK LOCKED");
    refreshMyCard();
    refreshSuperLockEditor();
  } catch {
    if (msg) msg.textContent = "NETWORK ERROR";
  }
}
async function saveSuperLockText(raw) {
  const price = Number(document.getElementById("mycard-sl-price")?.value);
  const text = (raw || "").trim();
  const msg = document.getElementById("mycard-sl-msg");
  if (!text) {
    if (msg) msg.textContent = "ENTER A SUPER LOCK FIRST";
    return;
  }
  if (!Number.isInteger(price) || Math.abs(price) < 100 || price < -120) {
    if (msg) msg.textContent = "ENTER ODDS: -120 TO -100, OR +100 AND UP";
    return;
  }
  try {
    const r = await fetch("/api/picks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season: 2026,
        week: myCardWeek(),
        picks: [{ bet_type: "Super Lock", pick_text: text, price }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      if (msg)
        msg.textContent =
          j.error === "locked"
            ? "LOCKED · CUTOFF PASSED"
            : j.error === "super-lock-price"
              ? "ODDS MUST BE -120 OR LONGER"
              : j.detail || "ERROR · " + (j.error || "");
      return;
    }
    // Free-text overwrites any prior structured pick, so clear prop metadata.
    currentMyPicks["Super Lock"] = {
      pick_text: text,
      price,
      locked_at: new Date().toISOString(),
    };
    superLockState.editing = false;
    showToast("SUPER LOCK SAVED");
    refreshMyCard();
    refreshSuperLockEditor();
  } catch {
    if (msg) msg.textContent = "NETWORK ERROR";
  }
}
async function markSuperLockMyCard(result) {
  try {
    const r = await fetch("/api/picks?action=mark-super-lock", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ season: 2026, week: myCardWeek(), result }),
    });
    const j = await r.json();
    if (!r.ok) {
      showToast("MARK ERROR: " + (j.error || ""), "err");
      return;
    }
    currentMyPicks["Super Lock"] = {
      ...(currentMyPicks["Super Lock"] || {}),
      result,
    };
    showToast(`SUPER LOCK MARKED ${result}`);
    refreshSuperLockEditor();
  } catch {
    showToast("NETWORK ERROR", "err");
  }
}

// ---- Picks tab: week navigator + past-week history ----
