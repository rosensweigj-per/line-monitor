// "Best price" lookup: find a team's game(s) and compare every book's moneyline / spread / total,
// with Pinnacle's no-vig fair price and the EV at each book. Pure functions + one render.
import { BOOKS, SPORTS, dec, fairProb, lineOk, openLink, toAmerican } from "./scan.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
/** Every query word must start some word of the team name: "mich st" -> Michigan State Spartans. */
export function teamMatches(team, query) {
  const words = norm(team);
  const q = norm(query);
  return q.length > 0 && q.every((t) => words.some((w) => w.startsWith(t)));
}

/** [{ sport, events }] -> matching events (soonest first, games not more than 4h past start). */
export function findGames(eventsBySport, query, now = Date.now()) {
  const out = [];
  for (const [sport, events] of Object.entries(eventsBySport)) {
    for (const e of events || []) {
      if (Date.parse(e.commence_time) < now - 4 * 3600e3) continue;
      const side = teamMatches(e.home_team, query) ? e.home_team : teamMatches(e.away_team, query) ? e.away_team : null;
      if (side) out.push({ sport, event: e, team: side });
    }
  }
  return out.sort((a, b) => Date.parse(a.event.commence_time) - Date.parse(b.event.commence_time));
}

const fairP = (pm, name) => {
  const po = pm?.outcomes?.find((o) => o.name === name);
  const other = pm?.outcomes?.find((o) => o !== po);
  if (!po || !other || pm.outcomes.length !== 2) return null;
  return { p: fairProb(po.price, other.price, pm.key), po };
};

/**
 * Compare books for one game. For each market and side: every book's line/price, the EV vs Pinnacle's fair
 * (better-number lines get a floor "≥", worse numbers get no EV), and the best book (highest EV, else best price).
 */
export function compareBooks(event, team, { skipBooks = new Set() } = {}) {
  const pin = event.bookmakers?.find((b) => b.key === "pinnacle");
  const opp = event.home_team === team ? event.away_team : event.home_team;
  const sides = { h2h: [team, opp], spreads: [team, opp], totals: ["Over", "Under"] };
  const result = {};
  for (const [mk, names] of Object.entries(sides)) {
    const pm = pin?.markets?.find((m) => m.key === mk);
    result[mk] = names.map((name) => {
      const fair = fairP(pm, name);
      const rows = [];
      for (const b of event.bookmakers || []) {
        if (!BOOKS[b.key] || skipBooks.has(b.key)) continue;
        const o = b.markets?.find((m) => m.key === mk)?.outcomes?.find((x) => x.name === name);
        if (!o) continue;
        let ev = null, floor = false;
        if (fair && lineOk(mk, fair.po, o)) { ev = fair.p * dec(o.price) - 1; floor = o.point !== fair.po.point; }
        rows.push({ bookKey: b.key, book: BOOKS[b.key], price: o.price, point: o.point, ev, floor, link: o.link || b.markets.find((m) => m.key === mk)?.link || b.link });
      }
      rows.sort((a, b) => (b.ev ?? -9) - (a.ev ?? -9) || (mk === "spreads" ? (b.point - a.point) : 0) || (mk === "totals" ? (name === "Over" ? a.point - b.point : b.point - a.point) : 0) || dec(b.price) - dec(a.price));
      return { name, fair: fair ? { american: toAmerican(fair.p), point: fair.po.point, pinPrice: fair.po.price } : null, rows };
    });
  }
  return result;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sg = (n) => (n > 0 ? `+${n}` : `${n}`);
const et = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

/** HTML for /best. games: [{ sport, event, team, cmp }] */
export function renderBest({ q = "", games = [], error = null, token = "", css = "", shortcutBooks = new Set(), now = Date.now() }) {
  const t = encodeURIComponent(token);
  const label = { h2h: "Moneyline", spreads: "Spread", totals: "Total" };
  const side = (mk, s) => {
    if (!s.rows.length) return "";
    const head = mk === "h2h" ? `${esc(s.name)} ML` : mk === "spreads" ? esc(s.name) : esc(s.name);
    const fair = s.fair ? `fair ${sg(s.fair.american)}${mk !== "h2h" ? ` at ${mk === "spreads" ? sg(s.fair.point) : s.fair.point}` : ""} (Pin ${sg(s.fair.pinPrice)})` : "no Pinnacle price";
    const rows = s.rows.map((r, i) => {
      const href = openLink(r.bookKey, r.link, shortcutBooks);
      const line = mk === "h2h" ? "" : `${mk === "spreads" ? sg(r.point) : r.point} `;
      const ev = r.ev == null ? "—" : `${r.floor ? "≥" : ""}${(r.ev * 100).toFixed(1)}%`;
      return `<div class="brow${i === 0 ? " best" : ""}"><span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.book)}</a>` : esc(r.book)}</span><span>${line}<b>${sg(r.price)}</b></span><span class="${r.ev > 0 ? "pos" : "neg"}">${ev}</span></div>`;
    }).join("");
    return `<div class="side"><div class="sh"><b>${head}</b><span class="muted">${esc(fair)}</span></div>${rows}</div>`;
  };
  const body = error ? `<div class="err">${esc(error)}</div>`
    : q && !games.length ? `<p class="empty">No upcoming game found for “${esc(q)}”.</p>`
    : games.map((g) => `<section class="game"><h2>${esc(SPORTS[g.sport] || g.sport)} · ${esc(g.event.away_team)} @ ${esc(g.event.home_team)}</h2>
<div class="status">${et(g.event.commence_time)} ET${Date.parse(g.event.commence_time) <= now ? " · <b>live</b>" : ""} · best book first · EV vs Pinnacle no-vig</div>
${["h2h", "spreads", "totals"].map((mk) => `<fieldset><legend>${label[mk]}</legend>${g.cmp[mk].map((s) => side(mk, s)).join("")}</fieldset>`).join("")}
</section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a2e1a">
<title>Best price</title>
<style>${css}
.search{display:flex;gap:8px;margin:6px 0 14px}.search input{flex:1;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text)}
h2{font-size:17px;margin:18px 0 2px}.side{padding:6px 0 10px}.side+.side{border-top:1px solid var(--line)}
.sh{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:4px}.muted{color:var(--muted);font-size:13px}
.brow{display:grid;grid-template-columns:1fr auto 70px;gap:10px;padding:5px 6px;border-radius:8px;font-variant-numeric:tabular-nums}
.brow span:last-child{text-align:right}.brow.best{background:color-mix(in srgb,var(--good) 14%,transparent)}
.brow a{color:var(--text)}.pos{color:var(--good);font-weight:600}.neg{color:var(--muted)}
</style></head><body><main>
<header><h1>Best price</h1><div class="actions"><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<form class="search" method="get" action="/best"><input type="hidden" name="token" value="${esc(token)}">
<input name="q" value="${esc(q)}" placeholder="Team, e.g. Mich St" autocapitalize="words"><button type="submit">Find</button></form>
<div class="status">About 3 Odds API credits per game found.</div>
${body}
</main></body></html>`;
}
