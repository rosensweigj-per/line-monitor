// Consensus fair price (paper test). For a book's price, the fair chance is the no-vig average of every OTHER
// bookmaker in the pull at the exact same number (Pinnacle counted twice). The book being priced is left out, so
// one stale book can't move its own fair price. Used only for the shadow log; it never alerts.
import { BOOKS, dec, fairProb, toAmerican } from "./scan.mjs";

export const CONS_MIN_BOOKS = 3;  // other books needed at the exact number (Pinnacle counts once here)
export const PIN_WEIGHT = 2;
const MAIN = ["h2h", "spreads", "totals"];
const nm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The opposite outcome of `o` in a book's market (same player/number rules as the monitor). */
function opposite(market, o, mk) {
  if (mk === "h2h") return market.outcomes.length === 2 ? market.outcomes.find((x) => x.name !== o.name) : null;
  if (mk === "spreads") return market.outcomes.find((x) => x.name !== o.name && x.point === -o.point);
  // totals and props: other half of the same line (same player for props)
  return market.outcomes.find((x) => x.name !== o.name && x.point === o.point && nm(x.description) === nm(o.description));
}
const sameSide = (a, b) => a.name === b.name && a.point === b.point && nm(a.description) === nm(b.description);

/**
 * Consensus no-vig chance for outcome `o` in market `mk`, from every bookmaker except `excludeKey`.
 * Returns { p, n, books } or null if fewer than CONS_MIN_BOOKS other books price that exact number.
 */
export function consensusProb(bookmakers, mk, o, excludeKey) {
  let sum = 0, w = 0;
  const books = [];
  for (const b of bookmakers || []) {
    if (b.key === excludeKey) continue;
    const m = b.markets?.find((x) => x.key === mk);
    const me = m?.outcomes?.find((x) => sameSide(x, o));
    const other = me && opposite(m, me, mk);
    if (!other) continue;
    const weight = b.key === "pinnacle" ? PIN_WEIGHT : 1;
    sum += fairProb(me.price, other.price, mk) * weight;
    w += weight;
    books.push(b.key);
  }
  return books.length >= CONS_MIN_BOOKS ? { p: sum / w, n: books.length, books } : null;
}

/**
 * Every price at Jason's books that beats the consensus by minEv, for a list of games (main lines) or one event
 * (props: pass [event] and the prop market keys). Same odds window and book on/off rules as the monitor.
 */
export function consensusEdges(games, sportKey, { markets = MAIN, minEv = 0.03, minOdds = -300, maxOdds = 300, skipBooks = new Set(), now = Date.now() } = {}) {
  const out = [];
  for (const g of games || []) {
    if (Date.parse(g.commence_time) <= now) continue;
    for (const b of g.bookmakers || []) {
      if (!BOOKS[b.key] || skipBooks.has(b.key)) continue;
      for (const m of b.markets || []) {
        if (!markets.includes(m.key)) continue;
        for (const o of m.outcomes || []) {
          if (o.price < minOdds || o.price > maxOdds) continue;
          const c = consensusProb(g.bookmakers, m.key, o, b.key);
          if (!c) continue;
          const ev = c.p * dec(o.price) - 1;
          if (ev < minEv) continue;
          out.push({
            eventId: g.id, sportKey, game: `${g.away_team} @ ${g.home_team}`, start: g.commence_time,
            market: m.key, side: o.name, player: o.description || "", point: o.point ?? null,
            bookKey: b.key, book: BOOKS[b.key], odds: o.price,
            consProb: c.p, consFair: toAmerican(c.p), consBooks: c.n, consEv: ev,
          });
        }
      }
    }
  }
  return out;
}
