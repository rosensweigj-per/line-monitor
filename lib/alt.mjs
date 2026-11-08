// Better-number pricing. When a book offers a better spread/total number than Pinnacle's main line (e.g. +3.5 vs +3),
// the monitor's base EV is a conservative floor (Pin's probability at its own number). This module prices the extra
// half points properly:
//   1. Pinnacle's own alternate line at the book's exact number (one alt-lines call per game, cached 15 min), or
//   2. landing chances derived from Pinnacle's alt ladder (price difference between k-0.5 and k+0.5), or
//   3. a conservative key-number model, used only as a screen, a cross-check, and (when no alt data / cap hit)
//      as the fallback for NFL/NCAAF spreads crossing 3 or 7.
// Safeguards: alts only within 1.5 pts of the main line and < 45 min old; alt vs model > 3 pts of probability apart
// -> CHECK (shown, not alerted); daily credit cap on alt fetches.
import { dec, toAmerican } from "./scan.mjs";

const ALT_MARKET = { spreads: "alternate_spreads", totals: "alternate_totals" };
export const ALT_CACHE_MS = 15 * 60e3;
const MAX_ALT_DIST = 1.5;     // only trust alt prices this close to Pinnacle's main line
const MAX_TRIGGER_DIST = 1;   // only re-price better numbers this close
const MAX_ALT_AGE_MIN = 45;
const CHECK_GAP = 0.03;       // alt vs model win-probability gap that flags CHECK
const imp = (o) => 1 / dec(o);
const isInt = (x) => Math.abs(x - Math.round(x)) < 1e-9;

// ---------- key-number model (conservative landing chances per integer) ----------
const SPREAD_Q = {
  americanfootball_nfl: { map: { 3: 0.08, 7: 0.055, 10: 0.035, 6: 0.03, 4: 0.03, 14: 0.03, 1: 0.025, 2: 0.025, 5: 0.025, 8: 0.025 }, near: 0.02, far: 0.01 },
  americanfootball_ncaaf: { map: { 3: 0.05, 7: 0.045, 10: 0.03, 4: 0.025, 6: 0.025, 14: 0.025, 1: 0.02, 2: 0.02 }, near: 0.02, far: 0.01 },
  basketball_nba: { map: {}, near: 0.03, far: 0.02 },
  basketball_ncaab: { map: {}, near: 0.03, far: 0.02 },
};
const TOTAL_Q = {
  americanfootball_nfl: { map: { 37: 0.03, 41: 0.035, 43: 0.03, 44: 0.035, 47: 0.03, 51: 0.03 }, near: 0.02, far: 0.02 },
  americanfootball_ncaaf: { map: {}, near: 0.015, far: 0.015 },
  basketball_nba: { map: {}, near: 0.012, far: 0.012 },
  basketball_ncaab: { map: {}, near: 0.012, far: 0.012 },
  icehockey_nhl: { map: { 4: 0.08, 5: 0.11, 6: 0.11, 7: 0.09, 8: 0.06 }, near: 0.04, far: 0.04 },
};
/** Model chance the game lands exactly on integer k (margin for spreads, total for totals); null = no model. */
export function modelQ(sport, market, k) {
  const t = (market === "spreads" ? SPREAD_Q : TOTAL_Q)[sport];
  if (!t) return null;
  const a = Math.abs(Math.round(k));
  return t.map[a] ?? (market === "spreads" && a > 20 ? t.far : t.near);
}

// ---------- the math ----------
// Every bet is expressed as "win iff m < line" so better numbers are always a higher line:
// spreads: m = points the side loses by, line = its spread; Over: m = -total, line = -L; Under: m = total, line = L.
const toM = (market, side, point) => (market === "totals" && side === "Over" ? -point : point);

/**
 * Win / push / loss chances at the book's number, from Pin's no-vig chance at its own number plus landing chances.
 * q(k) gives the landing chance at integer k in m-space (or null if unknown -> returns null).
 */
export function probsAtBetterNumber({ market, side, pinPoint, point, p, q }) {
  const lp = toM(market, side, pinPoint), lb = toM(market, side, point);
  if (!(lb > lp)) return null;
  const qAt = (k) => q(k);
  const pushP = isInt(lp) ? qAt(lp) : 0;
  if (pushP == null) return null;
  let win = p * (1 - pushP) + pushP;
  for (let k = Math.floor(lp) + 1; k < lb - 1e-9; k++) {
    const x = qAt(k);
    if (x == null) return null;
    win += x;
  }
  const pushB = isInt(lb) ? qAt(lb) : 0;
  if (pushB == null) return null;
  return { win, push: pushB, loss: Math.max(0, 1 - win - pushB) };
}
export const evOf = (pr, price) => pr.win * (dec(price) - 1) - pr.loss;
const fairAmerican = (pr) => toAmerican(pr.win / (pr.win + pr.loss));
/** Integers crossed (incl. Pin's own if it was a push) — what the extra half points buy. */
export function crossed(market, side, pinPoint, point) {
  const lp = toM(market, side, pinPoint), lb = toM(market, side, point);
  const out = [];
  for (let k = isInt(lp) ? Math.round(lp) : Math.floor(lp) + 1; k < lb - 1e-9; k++) out.push(k);
  return out;
}
/** Model fallback is allowed only for NFL/NCAAF spreads whose extra number is 3 or 7. */
export function modelFallbackAllowed(h) {
  if (h.market !== "spreads" || !/^americanfootball_(nfl|ncaaf)$/.test(h.sportKey)) return false;
  const ks = crossed(h.market, h.side, h.pinPoint, h.point).map((k) => Math.abs(k));
  return ks.length > 0 && ks.every((k) => k === 3 || k === 7);
}

// ---------- candidates ----------
/** Better-number hits worth re-pricing: within 1 pt of Pin's number and floor EV > -7% or model EV near the bar. */
export function candidatesFrom(hits, minEvFor) {
  return hits.filter((h) => {
    if (!h.betterLine || !ALT_MARKET[h.market] || h.p == null) return false;
    if (Math.abs(h.point - h.pinPoint) > MAX_TRIGGER_DIST + 1e-9) return false;
    if (h.ev > -0.07) return true;
    const pr = probsAtBetterNumber({ ...h, q: (k) => modelQ(h.sportKey, h.market, k) });
    return pr != null && evOf(pr, h.odds) >= minEvFor(h.market) - 0.01;
  });
}

// ---------- Pinnacle alt ladder ----------
/** Pin's no-vig win chance for `side` at exactly `point` from an alt market (both sides required), or null. */
export function altWinAt(altMarket, market, side, point, opp) {
  if (!altMarket?.outcomes) return null;
  const me = altMarket.outcomes.find((o) => o.name === side && o.point === point);
  const other = market === "totals"
    ? altMarket.outcomes.find((o) => o.name === (side === "Over" ? "Under" : "Over") && o.point === point)
    : altMarket.outcomes.find((o) => o.name === opp && o.point === -point);
  if (!me || !other) return null;
  return { p: imp(me.price) / (imp(me.price) + imp(other.price)), price: me.price };
}

/**
 * Re-price one candidate from Pinnacle's alt market for its game. Returns the hit with a refined EV and
 * fairSource "Pin alt" | "Pin ladder" | "model", or null to keep the floor. Sets check=true when alt and model disagree.
 */
export function refine(h, { altMarket, altFresh, opp }) {
  const model = (k) => modelQ(h.sportKey, h.market, k);
  const modelPr = probsAtBetterNumber({ ...h, q: model });
  const withinAlt = (pt) => Math.abs(pt - h.pinPoint) <= MAX_ALT_DIST + 1e-9;
  const done = (pr, fairSource, note, extra = {}) => {
    const ev = evOf(pr, h.odds);
    const out = { ...h, ev, floorEv: h.ev, fair: fairAmerican(pr), fairSource, fairNote: note, kellyQ: Math.max(0, ev / (dec(h.odds) - 1) / 4), ...extra };
    if (fairSource !== "model" && modelPr && Math.abs(modelPr.win - pr.win) > CHECK_GAP) {
      out.check = true;
      out.fairNote += ` · CHECK: model says ${toAmerican(modelPr.win / (modelPr.win + modelPr.loss))}`;
    }
    return out;
  };

  if (altMarket && altFresh) {
    const mSide = h.side, sidePt = h.point;
    // 1) Pin's price at the book's exact number
    const exact = withinAlt(sidePt) ? altWinAt(altMarket, h.market, mSide, sidePt, opp) : null;
    if (exact) {
      const lb = toM(h.market, mSide, sidePt);
      const push = isInt(lb) ? ladderQ(Math.round(lb)) ?? model(lb) ?? 0 : 0;
      const pr = { win: exact.p * (1 - push), push, loss: (1 - exact.p) * (1 - push) };
      return done(pr, "Pin alt", `Pin alt ${fmtPt(h, sidePt)} ${exact.price > 0 ? "+" : ""}${exact.price}`);
    }
    // 2) landing chances from the ladder around the crossed numbers
    const pr = probsAtBetterNumber({ ...h, q: (k) => ladderQ(k) });
    if (pr) return done(pr, "Pin ladder", `Pin ladder: lands on ${crossed(h.market, mSide, h.pinPoint, sidePt).map((k) => Math.abs(k)).join(", ")}`);
  }
  // 3) model fallback (NFL/NCAAF spreads around 3 and 7 only)
  if (modelPr && modelFallbackAllowed(h)) {
    const ks = crossed(h.market, h.side, h.pinPoint, h.point);
    return done(modelPr, "model", `model: ${ks.map((k) => `${Math.abs(k)} lands ~${Math.round(model(k) * 100)}%`).join(", ")}`);
  }
  return null;

  // landing chance at integer k (m-space) from Pin's half-point alts on either side of it
  function ladderQ(k) {
    const halfPt = (mv) => (h.market === "totals" && h.side === "Over" ? -mv : mv); // back from m-space to the side's point
    const lo = halfPt(k - 0.5), hi = halfPt(k + 0.5);
    if (!withinAlt(lo) || !withinAlt(hi)) return null;
    const a = altWinAt(altMarket, h.market, h.side, lo, opp), b = altWinAt(altMarket, h.market, h.side, hi, opp);
    if (!a || !b) return null;
    const q = b.p - a.p;
    return q > 0 && q < 0.25 ? q : null;
  }
}
const fmtPt = (h, pt) => (h.market === "spreads" ? (pt > 0 ? `+${pt}` : `${pt}`) : `${pt}`);

// ---------- orchestration (fetch once per game, cache, daily cap) ----------
const dayET = (now) => new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/**
 * Re-price better-number candidates. fetchAlt({ sport, eventId, markets }) -> { json, headers }.
 * Returns { refined: [hits], stats }. Uses blobs "altCache" (15 min per game+market) and "altBudget" (credits/day).
 */
export async function priceBetterNumbers(cands, { store, fetchAlt, cap = 100, now = Date.now(), games = {}, log = () => {} }) {
  const stats = { candidates: cands.length, games: 0, fetched: 0, cached: 0, alt: 0, ladder: 0, model: 0, check: 0, floor: 0, capped: 0, creditsToday: 0, cap };
  if (!cands.length) return { refined: [], stats };
  const cache = (await store.get("altCache", { type: "json" })) || {};
  for (const k of Object.keys(cache)) if (now - cache[k].at > ALT_CACHE_MS) delete cache[k];
  const budget = (await store.get("altBudget", { type: "json" })) || {};
  if (budget.day !== dayET(now)) { budget.day = dayET(now); budget.used = 0; }

  const byGame = new Map();
  for (const h of cands) {
    const g = byGame.get(h.eventId) || { sport: h.sportKey, hits: [], markets: new Set() };
    g.hits.push(h); g.markets.add(ALT_MARKET[h.market]); byGame.set(h.eventId, g);
  }
  stats.games = byGame.size;
  const refined = [];
  for (const [eventId, g] of byGame) {
    const need = [...g.markets].filter((m) => !cache[`${eventId}|${m}`]);
    if (need.length) {
      if (budget.used + need.length > cap) { stats.capped++; }
      else {
        try {
          const r = await fetchAlt({ sport: g.sport, eventId, markets: need.join(",") });
          const cost = Number(r.headers?.get?.("x-requests-last"));
          budget.used += Number.isFinite(cost) ? cost : need.length;
          const pin = r.json?.bookmakers?.find((b) => b.key === "pinnacle");
          for (const m of need) cache[`${eventId}|${m}`] = { at: now, market: pin?.markets?.find((x) => x.key === m) || null };
          stats.fetched++;
        } catch (e) { log(`[alt ${eventId}] ${e.message}`); }
      }
    } else stats.cached++;
    for (const h of g.hits) {
      const entry = cache[`${eventId}|${ALT_MARKET[h.market]}`];
      const altMarket = entry?.market || null;
      const altFresh = !!altMarket && (now - Date.parse(altMarket.last_update || 0)) / 60000 <= MAX_ALT_AGE_MIN;
      const opp = games[eventId] ? (games[eventId].home_team === h.side ? games[eventId].away_team : games[eventId].home_team) : h.opp;
      const r = refine(h, { altMarket, altFresh, opp });
      if (!r) { stats.floor++; continue; }
      stats[r.fairSource === "Pin alt" ? "alt" : r.fairSource === "Pin ladder" ? "ladder" : "model"]++;
      if (r.check) stats.check++;
      refined.push(r);
    }
  }
  stats.creditsToday = budget.used;
  await store.setJSON("altCache", cache);
  await store.setJSON("altBudget", budget);
  return { refined, stats };
}
