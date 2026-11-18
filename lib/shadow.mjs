// Paper test: Pinnacle method vs consensus method. Logs every edge either method finds (first sighting only),
// records both closing prices ~10 min before start, settles main lines from final scores, and summarizes.
// No alerts, no stakes; results are scored at a flat 1 unit per bet. Blob "shadow".
import { dec, fairProb, toAmerican, SPORTS } from "./scan.mjs";
import { consensusProb } from "./consensus.mjs";

const CLOSE_WINDOW_MS = 10 * 60e3;
const nm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const shadowKey = (method, e) => [method, e.eventId, e.market, nm(e.player), nm(e.side), e.point ?? "", e.bookKey].join("|");

/** Add first sightings to the log. entries: monitor hits (method "pinnacle") or consensus edges (method "consensus"). */
export function logShadow(shadow, method, entries, now) {
  let added = 0;
  for (const e of entries) {
    const k = shadowKey(method, e);
    if (shadow[k]) { shadow[k].seen++; continue; }
    shadow[k] = {
      method, at: new Date(now).toISOString(), seen: 1,
      sportKey: e.sportKey, sport: SPORTS[e.sportKey] || e.sportKey, eventId: e.eventId, game: e.game, start: e.start,
      market: e.market, side: e.side, player: e.player || "", point: e.point ?? null,
      bookKey: e.bookKey, book: e.book, odds: e.odds,
      ev: method === "consensus" ? e.consEv : e.ev,
      fair: method === "consensus" ? e.consFair : e.fair,
    };
    added++;
  }
  return added;
}

/** Pinnacle's no-vig chance for an entry's exact outcome in a bookmakers list, or null. */
function pinProb(bookmakers, e) {
  const pin = bookmakers?.find((b) => b.key === "pinnacle");
  const m = pin?.markets?.find((x) => x.key === e.market);
  const me = m?.outcomes?.find((o) => nm(o.name) === nm(e.side) && (o.point ?? null) === e.point && nm(o.description) === nm(e.player));
  if (!me) return null;
  const other = e.market === "h2h" ? m.outcomes.find((o) => o !== me)
    : e.market === "spreads" ? m.outcomes.find((o) => o.name !== me.name && o.point === -me.point)
    : m.outcomes.find((o) => o.name !== me.name && o.point === me.point && nm(o.description) === nm(me.description));
  return other ? fairProb(me.price, other.price, e.market) : null;
}

/**
 * Closes for entries whose game starts within 10 minutes: one all-books event pull per game (the entries' markets),
 * then consensus close (excluding the entry's own book) and Pinnacle close at the entry's exact number.
 */
export async function closeShadow(shadow, { getEvent, now, budget, cap }) {
  const due = new Map();
  for (const e of Object.values(shadow)) {
    if (e.closedAt || e.noClose) continue;
    const t = Date.parse(e.start);
    if (!(t > now && t - now <= CLOSE_WINDOW_MS)) continue;
    const g = due.get(e.eventId) || { sport: e.sportKey, entries: [], markets: new Set() };
    g.entries.push(e); g.markets.add(e.market); due.set(e.eventId, g);
  }
  let closed = 0;
  for (const [eventId, g] of due) {
    if (budget.used + g.markets.size > cap) break;
    let ev = null, cost = 0;
    try {
      const r = await getEvent({ sport: g.sport, eventId, markets: [...g.markets].join(",") });
      ev = r.json; cost = Number(r.headers?.get?.("x-requests-last"));
    } catch { /* counted below */ }
    budget.used += Math.max(Number.isFinite(cost) ? cost : 0, g.markets.size);
    for (const e of g.entries) {
      const o = { name: e.side, point: e.point ?? undefined, description: e.player || undefined };
      const c = ev && consensusProb(ev.bookmakers, e.market, o, e.bookKey);
      const p = ev && pinProb(ev.bookmakers, e);
      e.closedAt = new Date(now).toISOString();
      if (c) { e.consClose = toAmerican(c.p); e.consClv = c.p * dec(e.odds) - 1; }
      if (p != null) { e.pinClose = toAmerican(p); e.pinClv = p * dec(e.odds) - 1; }
      if (!c && p == null) e.noClose = true;
      closed++;
    }
  }
  return closed;
}

/** win / loss / push for a main-line entry from a completed Odds API score record, else null. */
export function gradeMain(e, score) {
  if (!score?.completed || !Array.isArray(score.scores)) return null;
  const pts = Object.fromEntries(score.scores.map((s) => [nm(s.name), Number(s.score)]));
  const teams = Object.keys(pts);
  if (teams.length !== 2 || teams.some((k) => !Number.isFinite(pts[k]))) return null;
  const res = (x) => (x > 0 ? "win" : x < 0 ? "loss" : "push");
  if (e.market === "totals") {
    const total = pts[teams[0]] + pts[teams[1]];
    return res(e.side === "Over" ? total - e.point : e.point - total);
  }
  const me = pts[nm(e.side)];
  const them = teams.filter((k) => k !== nm(e.side)).map((k) => pts[k])[0];
  if (!Number.isFinite(me) || !Number.isFinite(them)) return null;
  return res(e.market === "h2h" ? me - them : me + e.point - them);
}

/** Settle finished main-line entries: one scores call per sport (daysFrom=3). Props stay unsettled (no stats feed). */
export async function settleShadow(shadow, { getScores, now, budget, cap }) {
  const sports = new Set();
  for (const e of Object.values(shadow)) {
    if (!e.result && e.market && ["h2h", "spreads", "totals"].includes(e.market) && Date.parse(e.start) < now - 3 * 3600e3
        && Date.parse(e.start) > now - 3 * 86400e3) sports.add(e.sportKey);
  }
  let settled = 0;
  for (const sport of sports) {
    if (budget.used + 2 > cap) break;
    let scores = [], cost = 0;
    try { const r = await getScores(sport); scores = r.json || []; cost = Number(r.headers?.get?.("x-requests-last")); } catch { /* skip */ }
    budget.used += Math.max(Number.isFinite(cost) ? cost : 0, 2);
    const byId = new Map(scores.map((s) => [s.id, s]));
    for (const e of Object.values(shadow)) {
      if (e.result || e.sportKey !== sport || !["h2h", "spreads", "totals"].includes(e.market)) continue;
      const g = gradeMain(e, byId.get(e.eventId));
      if (g) { e.result = g; e.units = g === "win" ? dec(e.odds) - 1 : g === "loss" ? -1 : 0; settled++; }
    }
  }
  return settled;
}

/** Side-by-side summary per method and market group. */
export function summarizeShadow(shadow, { since = 0 } = {}) {
  const rows = Object.values(shadow).filter((e) => Date.parse(e.at) >= since);
  const groups = {};
  for (const e of rows) {
    const grp = e.market.startsWith("player_") ? "props" : "main lines";
    const k = `${e.method}|${grp}`;
    const g = (groups[k] ||= { method: e.method, group: grp, bets: 0, ev: 0, consClv: [], pinClv: [], w: 0, l: 0, p: 0, units: 0, settled: 0 });
    g.bets++; g.ev += e.ev || 0;
    if (e.consClv != null) g.consClv.push(e.consClv);
    if (e.pinClv != null) g.pinClv.push(e.pinClv);
    if (e.result) { g.settled++; g.units += e.units; g[e.result[0]]++; }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return Object.values(groups).map((g) => ({
    method: g.method, group: g.group, bets: g.bets, avgEv: g.bets ? g.ev / g.bets : null,
    consClv: avg(g.consClv), consBeat: g.consClv.filter((x) => x > 0).length, consN: g.consClv.length,
    pinClv: avg(g.pinClv), pinBeat: g.pinClv.filter((x) => x > 0).length, pinN: g.pinClv.length,
    record: `${g.w}-${g.l}${g.p ? `-${g.p}` : ""}`, settled: g.settled, units: g.units, roi: g.settled ? g.units / g.settled : null,
  })).sort((a, b) => (a.group + a.method).localeCompare(b.group + b.method));
}
