export const QUOTE_MAX_AGE_MS = 2 * 60 * 1000;
export function freshQuote(quote, parent = null, now = Date.now()) {
  const timestamp = quote?.updated || parent?.updated;
  const age = now - Date.parse(timestamp);
  return (
    !!quote &&
    !quote.stale &&
    !parent?.stale &&
    Number.isFinite(age) &&
    age >= -5000 &&
    age <= QUOTE_MAX_AGE_MS
  );
}
export function verifiedGames(payload, now = Date.now()) {
  if (payload?.stale || payload?.source === "mock") return null;
  return (payload?.games || []).map((g) => ({
    ...g,
    books: Object.fromEntries(
      Object.entries(g.books || {}).map(([book, b]) => [
        book,
        {
          ...b,
          spread: freshQuote(b.spread, b, now) ? b.spread : null,
          total: freshQuote(b.total, b, now) ? b.total : null,
        },
      ]),
    ),
  }));
}
export function verifiedMarkets(payload, now = Date.now()) {
  if (!Array.isArray(payload?.markets)) return null;
  return payload.markets.map((m) => ({
    ...m,
    players: (m.players || []).map((p) => ({
      ...p,
      fanduel: freshQuote(p.fanduel, null, now) ? p.fanduel : null,
      draftkings: freshQuote(p.draftkings, null, now) ? p.draftkings : null,
      alts: (p.alts || []).map((a) => ({
        ...a,
        fanduel: freshQuote(
          { updated: a.updated?.fanduel, stale: a.stale },
          null,
          now,
        )
          ? a.fanduel
          : null,
        draftkings: freshQuote(
          { updated: a.updated?.draftkings, stale: a.stale },
          null,
          now,
        )
          ? a.draftkings
          : null,
      })),
    })),
  }));
}
export function quoteChanged(expected, actual) {
  return (
    !!expected &&
    (!actual ||
      expected.book !== actual.book ||
      expected.price !== actual.price ||
      (expected.line == null
        ? actual.line != null
        : Number(expected.line) !== Number(actual.line)))
  );
}
