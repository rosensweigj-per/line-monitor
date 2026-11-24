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
export function consensusProb(bookmakers, mk, o, excludeKey, minBooks = CONS_MIN_BOOKS) {
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
  return books.length >= minBooks ? { p: sum / w, n: books.length, books } : null;
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

/**
 * Attach `cons` (consensus view of the same price) to monitor hits: { ev, fair, n } or { n: 0 } when too few other
 * books price that exact number. gamesById: eventId -> game/event with bookmakers. Information only.
 */
export function annotateConsensus(hits, gamesById) {
  for (const h of hits || []) {
    const g = gamesById?.[h.eventId];
    if (!g) continue;
    const c = consensusProb(g.bookmakers, h.market, { name: h.side, point: h.point ?? undefined, description: h.player || undefined }, h.bookKey);
    h.cons = c ? { ev: c.p * dec(h.odds) - 1, fair: toAmerican(c.p), n: c.n } : { n: 0 };
  }
  return hits;
}

/** One-line consensus verdict for alerts and pages, or "" when not computed. */
export function consNote(h) {
  const c = h?.cons;
  if (!c) return "";
  if (!c.n) return "Consensus: too few books at this number";
  const ev = `${c.ev >= 0 ? "+" : ""}${(c.ev * 100).toFixed(1)}%`;
  const fair = `fair ${c.fair > 0 ? "+" : ""}${c.fair}, ${c.n} books`;
  if (c.ev >= 0.03) return `✓ Consensus agrees: ${ev} (${fair})`;
  if (c.ev >= 0) return `~ Consensus: only ${ev} (${fair})`;
  return `✗ Consensus disagrees: ${ev} (${fair}) — Pinnacle may be off`;
}
export const consLevel = (h) => (!h?.cons?.n ? "none" : h.cons.ev >= 0.03 ? "agree" : h.cons.ev >= 0 ? "weak" : "disagree");
