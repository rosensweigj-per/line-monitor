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
        rows.push({ bookKey: b.key, book: BOOKS[b.key], price: o.price, point: o.point, ev, floor, p: ev == null ? null : fair.p, link: o.link || b.markets.find((m) => m.key === mk)?.link || b.link });
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

/** Profit boost: boosted decimal odds = 1 + (decimal − 1) × (1 + boost). boost 0.25 = 25%. */
export const boostedDec = (price, boost) => 1 + (dec(price) - 1) * (1 + boost);
export const decToAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
/** EV of a boosted bet against fair chance p. */
export const boostedEv = (price, p, boost) => p * boostedDec(price, boost) - 1;
export const BOOST_CHOICES = [0, 10, 20, 25, 30, 50, 100];

/** HTML for /best. games: [{ sport, event, team, cmp }]. boost: percent (0 = none); recalculated on the phone. */
export function renderBest({ q = "", games = [], error = null, token = "", css = "", shortcutBooks = new Set(), now = Date.now(), boost = 0 }) {
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
      const pick = `${r.book} ${mk === "h2h" ? `${s.name} ML` : `${s.name} ${line.trim()}`} ${sg(r.price)}`;
      const data = `data-price="${r.price}"${r.p != null ? ` data-p="${r.p}"` : ""}${r.floor ? " data-floor" : ""} data-pick="${esc(pick)}"`;
      return `<div class="brow${i === 0 ? " best" : ""}" ${data}><span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.book)}</a>` : esc(r.book)}</span><span>${line}<b>${sg(r.price)}</b><small class="bx"></small></span><span class="evc ${r.ev > 0 ? "pos" : "neg"}">${ev}</span></div>`;
    }).join("");
    return `<div class="side"><div class="sh"><b>${head}</b><span class="muted">${esc(fair)}</span></div>${rows}</div>`;
  };
  const body = error ? `<div class="err">${esc(error)}</div>`
    : q && !games.length ? `<p class="empty">No upcoming game found for “${esc(q)}”.</p>`
    : games.map((g) => `<section class="game"><h2>${esc(SPORTS[g.sport] || g.sport)} · ${esc(g.event.away_team)} @ ${esc(g.event.home_team)}</h2>
<div class="status">${et(g.event.commence_time)} ET${Date.parse(g.event.commence_time) <= now ? " · <b>live</b>" : ""} · best book first · EV vs Pinnacle no-vig</div>
<div class="bestboost"></div>
${["h2h", "spreads", "totals"].map((mk) => `<fieldset><legend>${label[mk]}</legend>${g.cmp[mk].map((s) => side(mk, s)).join("")}</fieldset>`).join("")}
</section>`).join("");
  const chips = games.length ? `<div class="boost" role="group" aria-label="Profit boost">
<span class="muted">Profit boost</span>${BOOST_CHOICES.map((b) => `<button type="button" class="chip${b === boost ? " on" : ""}" data-b="${b}" aria-pressed="${b === boost}">${b ? `${b}%` : "None"}</button>`).join("")}
</div>` : "";
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
.boost{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 10px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0}
.chip{font:inherit;font-size:14px;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);min-height:34px}
.chip.on{background:var(--text);color:var(--bg);border-color:var(--text)}
.bx{display:block;font-size:12px;color:var(--good);text-align:right}.bx:empty{display:none}
.bestboost{margin:6px 0 4px;font-size:14px}.bestboost:empty{display:none}
</style></head><body><main>
<header><h1>Best price</h1><div class="actions"><a class="btn2" href="/sgp?token=${t}">SGP</a><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<nav class="bottombar" aria-label="Pages"><a class="btn2" href="/edges?token=${t}">Edges</a><a class="btn2" href="/sgp?token=${t}">SGP</a></nav>
<form class="search" method="get" action="/best"><input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="boost" id="boostIn" value="${Number(boost) || 0}"><input name="q" value="${esc(q)}" placeholder="Team, e.g. Mich St" autocapitalize="words"><button type="submit">Find</button></form>
<div class="status">About 3 Odds API credits per game found. Boosts recalculate on your phone (no credits).</div>
${chips}
${body}
</main>
<script>
// Profit boost: boosted decimal = 1 + (decimal - 1) x (1 + boost). EV vs the same fair chance (Pinnacle no-vig).
(function(){
var dec=function(a){return a>0?1+a/100:1+100/-a}, am=function(d){return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1))};
var sg=function(n){return n>0?"+"+n:""+n};
function apply(b){
  document.querySelectorAll(".chip").forEach(function(c){var on=+c.dataset.b===b;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll(".game").forEach(function(g){
    var best=null;
    g.querySelectorAll(".brow").forEach(function(r){
      var price=+r.dataset.price, d=1+(dec(price)-1)*(1+b/100), bx=r.querySelector(".bx"), ev=r.querySelector(".evc");
      bx.textContent=b?"→ "+sg(am(d)):"";
      if(r.dataset.p==null){return}
      var e=+r.dataset.p*d-1, fl=r.hasAttribute("data-floor")?"≥":"";
      ev.textContent=fl+(e*100).toFixed(1)+"%"; ev.className="evc "+(e>0?"pos":"neg");
      if(!fl&&(!best||e>best.e))best={e:e,pick:r.dataset.pick,d:d};
    });
    var box=g.querySelector(".bestboost");
    box.innerHTML=b&&best?"<b>Best use of a "+b+"% boost:</b> "+best.pick.replace(/[&<>]/g,"")+" → "+sg(am(best.d))+" · <span class='"+(best.e>0?"pos":"neg")+"'>"+(best.e>0?"+":"")+(best.e*100).toFixed(1)+"% EV</span>"+(best.e<=0?" (not worth it here)":""):"";
  });
  var bi=document.getElementById("boostIn"); if(bi)bi.value=b;
  try{var u=new URL(location.href);b?u.searchParams.set("boost",b):u.searchParams.delete("boost");history.replaceState(null,"",u)}catch(e){}
}
document.querySelectorAll(".chip").forEach(function(c){c.addEventListener("click",function(){apply(+c.dataset.b)})});
apply(${Number(boost) || 0});
})();
</script></body></html>`;
}
