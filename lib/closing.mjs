// Closing-line capture for CLV. READ-ONLY toward the Bet Tracker: the monitor reads open bets (Pending tab), records
// Pinnacle's no-vig price at each bet's exact number shortly before tip, and serves those records at /closing for the
// tracker to fetch. It never writes to the sheet.
import { dec, SPORTS, toAmerican } from "./scan.mjs";

export const CLOSE_WINDOW_MS = 10 * 60e3; // capture once, in the last 10 minutes before start
const imp = (o) => 1 / dec(o);
const SPORT_KEY = Object.fromEntries(Object.entries(SPORTS).map(([k, label]) => [label.toUpperCase(), k]));

/** Sheet sport label ("NBA", "NCAAB", ...) or key -> Odds API sport key. */
export const sportKeyOf = (s) => SPORT_KEY[String(s || "").trim().toUpperCase()] || (SPORTS[s] ? s : "");

const nm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pair(market, a, bWhere) {
  const b = market.outcomes.find(bWhere);
  if (!a || !b) return null;
  return { p: imp(a.price) / (imp(a.price) + imp(b.price)), price: a.price, otherPrice: b.price, point: a.point ?? null };
}

/**
 * Pinnacle's no-vig price for one open bet at the bet's exact number.
 * bet: { market, side, player, ou, point }. pin: Pinnacle bookmaker object from an event-odds response.
 * Returns { closeProb, closeFair, pinPrice, pinPoint, source } or { missing: reason }.
 */
export function closeFor(bet, pin) {
  if (!pin?.markets?.length) return { missing: "no Pinnacle prices" };
  const get = (k) => pin.markets.find((m) => m.key === k);
  const done = (r, source) => ({ closeProb: r.p, closeFair: toAmerican(r.p), pinPrice: r.price, pinPoint: r.point, source });

  if (bet.market.startsWith("player_")) {
    const m = get(bet.market);
    if (!m) return { missing: "Pinnacle has no price for this prop" };
    const me = m.outcomes.find((o) => nm(o.description) === nm(bet.player) && o.name === bet.ou && o.point === bet.point);
    const r = me && pair(m, me, (o) => nm(o.description) === nm(bet.player) && o.name !== bet.ou && o.point === bet.point);
    return r ? done(r, "prop") : { missing: "Pinnacle has no price at your number" };
  }
  if (bet.market === "h2h") {
    const m = get("h2h");
    const me = m?.outcomes.find((o) => nm(o.name) === nm(bet.side));
    const r = me && m.outcomes.length === 2 && pair(m, me, (o) => o !== me);
    return r ? done(r, "main") : { missing: "no Pinnacle moneyline" };
  }
  // spreads / totals: main line if it's the bet's number, else Pinnacle's alternate at that exact number
  const isTot = bet.market === "totals";
  const matchMe = (o) => nm(o.name) === nm(bet.side) && o.point === bet.point;
  const matchOther = (o) => (isTot ? o.name !== bet.side && o.point === bet.point : nm(o.name) !== nm(bet.side) && o.point === -bet.point);
  for (const [key, source] of [[bet.market, "main"], [isTot ? "alternate_totals" : "alternate_spreads", "alt"]]) {
    const m = get(key);
    const me = m?.outcomes.find(matchMe);
    const r = me && pair(m, me, matchOther);
    if (r) return done(r, source);
  }
  return { missing: "Pinnacle has no price at your number" };
}

/** CLV as a percent: EV of the bet's odds against the closing no-vig probability. */
export const clvPct = (odds, closeProb) => (Number.isFinite(odds) && closeProb ? +((closeProb * dec(odds) - 1) * 100).toFixed(2) : null);

/**
 * One pass: for open bets whose game starts within CLOSE_WINDOW_MS and hasn't been captured, pull Pinnacle
 * (bet markets + alternates for spreads/totals) once per game and record the closes in blob "closing".
 * deps: { open (parsed Pending rows), getEvents(sport) -> events[], getPinnacle({ sport, eventId, markets }) -> { json, headers } }.
 */
export async function captureCloses({ store, open, getEvents, getPinnacle, now = Date.now(), cap = 60, log = () => {} }) {
  const stats = { pendingWithKey: 0, due: 0, captured: 0, missing: 0, credits: 0 };
  const closing = (await store.get("closing", { type: "json" })) || {};
  // Append-only for the season: records are never deleted, and a captured game is never re-captured or changed.
  const budget = (await store.get("closeBudget", { type: "json" })) || {};
  const day = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (budget.day !== day) { budget.day = day; budget.used = 0; }

  const bets = (open || []).filter((b) => b.eventId && b.market && sportKeyOf(b.sport));
  stats.pendingWithKey = bets.length;
  const bySport = new Map();
  for (const b of bets) {
    if (closing[b.gameKey]?.captured) continue;
    const s = sportKeyOf(b.sport);
    if (!bySport.has(s)) bySport.set(s, []);
    bySport.get(s).push(b);
  }
  for (const [sport, list] of bySport) {
    let events;
    try { events = await getEvents(sport); } catch (e) { log(`[close ${sport}] ${e.message}`); continue; }
    const startOf = new Map((events || []).map((e) => [e.id, Date.parse(e.commence_time)]));
    const games = new Map();
    for (const b of list) {
      const start = startOf.get(b.eventId);
      if (!Number.isFinite(start) || start <= now || start - now > CLOSE_WINDOW_MS) continue;
      const g = games.get(b.eventId) || { start, bets: [], markets: new Set() };
      g.bets.push(b);
      g.markets.add(b.market);
      if (b.market === "spreads") g.markets.add("alternate_spreads");
      if (b.market === "totals") g.markets.add("alternate_totals");
      games.set(b.eventId, g);
    }
    for (const [eventId, g] of games) {
      stats.due += g.bets.length;
      if (budget.used + g.markets.size > cap) { log(`[close] daily cap reached`); continue; }
      let pin = null, cost = 0;
      try {
        const r = await getPinnacle({ sport, eventId, markets: [...g.markets].join(",") });
        cost = Number(r.headers?.get?.("x-requests-last"));
        pin = r.json?.bookmakers?.find((x) => x.key === "pinnacle") || null;
      } catch (e) { log(`[close ${eventId}] ${e.message}`); }
      const spent = Math.max(Number.isFinite(cost) ? cost : 0, 1);
      budget.used += spent; stats.credits += spent;
      for (const b of g.bets) {
        const c = closeFor(b, pin);
        const rec = closing[b.gameKey] || { gameKey: b.gameKey, sport, eventId, market: b.market, side: b.side, point: b.point, bets: [] };
        Object.assign(rec, { start: new Date(g.start).toISOString(), capturedAt: new Date(now).toISOString(), captured: true,
          minutesBeforeStart: Math.round((g.start - now) / 60000), ...(c.missing ? { missing: c.missing } : c) });
        const row = { id: b.id, sheetRow: b.sheetRow, book: b.book, odds: b.odds, stake: b.stake, clvPct: c.missing ? null : clvPct(b.odds, c.closeProb) };
        rec.bets = [...rec.bets.filter((x) => x.id !== b.id), row];
        closing[b.gameKey] = rec;
        c.missing ? stats.missing++ : stats.captured++;
      }
    }
  }
  await store.setJSON("closing", closing);
  await store.setJSON("closeBudget", budget);
  stats.creditsToday = budget.used;
  return stats;
}

/** Flatten closes to one row per bet (CSV for the tracker). */
export const CSV_COLUMNS = ["id", "sheetRow", "gameKey", "closeFair", "clvPct", "source", "missing", "capturedAt"];
export function closesToCsv(closes) {
  const cell = (v) => {
    const t = v == null ? "" : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [];
  for (const c of [...closes].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))) {
    for (const b of c.bets || []) {
      rows.push([b.id, b.sheetRow, c.gameKey, c.missing ? "" : c.closeFair, b.clvPct ?? "", c.missing ? "" : c.source, c.missing || "", c.capturedAt]);
    }
  }
  return [CSV_COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
