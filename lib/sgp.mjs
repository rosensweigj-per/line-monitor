// Same-game parlay helper. The Odds API has no SGP prices, so this prices each LEG fairly (consensus no-vig of the other
// books at the exact number, Pinnacle counted twice) and works out the fair parlay price assuming the legs are unrelated,
// plus the lowest pre-boost SGP price that is +EV with Jason's boost. Information only; nothing is bet.
import { BOOKS, SPORTS, dec } from "./scan.mjs";
import { consensusProb } from "./consensus.mjs";

export const SGP_SPORTS = ["americanfootball_nfl", "basketball_nba"];
export const SGP_PROPS = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  americanfootball_nfl: ["player_pass_yds", "player_rush_yds", "player_receptions", "player_reception_yds"],
};
/** Alt-line market key for a base market (alternate_spreads, player_points_alternate, ...); null for moneylines. */
export const altKey = (mk) => (mk === "spreads" || mk === "totals" ? `alternate_${mk}` : mk.startsWith("player_") ? `${mk}_alternate` : null);
const BASE_OF = (k) => (k.startsWith("alternate_") ? k.slice(10) : k.endsWith("_alternate") ? k.slice(0, -10) : k);
export const sgpMarkets = (sport, { alt = false } = {}) => {
  const base = ["h2h", "spreads", "totals", ...(SGP_PROPS[sport] || [])];
  return (alt ? [...base, ...base.map(altKey).filter(Boolean)] : base).join(",");
};

/**
 * Fold each book's alt-line markets into its main market (alternate_spreads -> spreads, player_points_alternate ->
 * player_points), so an alt number is priced against every book that has that number, main or alt. A number in both
 * keeps the main price. Alt-only outcomes are marked alt: true.
 */
export function mergeAlt(bookmakers) {
  return (bookmakers || []).map((b) => {
    const byKey = new Map();
    for (const m of b.markets || []) {
      const base = BASE_OF(m.key), isAlt = base !== m.key;
      const cur = byKey.get(base) || { key: base, outcomes: [] };
      const seen = new Set(cur.outcomes.map((o) => `${o.name}|${o.description || ""}|${o.point ?? ""}`));
      for (const o of m.outcomes || []) {
        const k = `${o.name}|${o.description || ""}|${o.point ?? ""}`;
        if (seen.has(k)) { if (!isAlt) { const i = cur.outcomes.findIndex((x) => `${x.name}|${x.description || ""}|${x.point ?? ""}` === k); cur.outcomes[i] = o; } continue; }
        seen.add(k);
        cur.outcomes.push(isAlt ? { ...o, alt: true } : o);
      }
      byKey.set(base, cur);
    }
    return { ...b, markets: [...byKey.values()] };
  });
}

const sg = (n) => (n > 0 ? `+${n}` : `${n}`);
const SHORT = {
  player_points: "pts", player_rebounds: "reb", player_assists: "ast", player_threes: "3PM",
  player_pass_yds: "pass yds", player_rush_yds: "rush yds", player_receptions: "rec", player_reception_yds: "rec yds",
};
const short = (mk) => SHORT[mk] || mk;

/**
 * Every leg at every enabled book for one event: { key, name, legs: [{ id, mk, label, price, p, n, ev, team, player, ou }] }.
 * p = consensus no-vig chance from the other books at that exact number (needs at least 1 other book; n = how many).
 */
export function buildLegs(event, sport, { skipBooks = new Set(), minOdds = -1000, maxOdds = 1000 } = {}) {
  const markets = sgpMarkets(sport).split(",");
  const all = mergeAlt(event?.bookmakers);
  const books = [];
  for (const b of all) {
    if (!BOOKS[b.key] || skipBooks.has(b.key)) continue;
    const legs = [];
    for (const m of b.markets || []) {
      if (!markets.includes(m.key)) continue;
      for (const o of m.outcomes || []) {
        if (!Number.isFinite(o.price) || o.price < minOdds || o.price > maxOdds) continue;
        const c = consensusProb(all, m.key, o, b.key, 1);
        const isProp = m.key.startsWith("player_");
        const label = m.key === "h2h" ? `${o.name} ML`
          : m.key === "spreads" ? `${o.name} ${sg(o.point)}`
          : m.key === "totals" ? `${o.name} ${o.point}`
          : `${o.description} ${o.name === "Over" ? "O" : "U"} ${o.point} ${short(m.key)}`;
        legs.push({
          id: [m.key, o.description || "", o.name, o.point ?? ""].join("|"),
          mk: m.key, label, price: o.price,
          p: c ? +c.p.toFixed(5) : null, n: c ? c.n : 0, ev: c ? +(c.p * dec(o.price) - 1).toFixed(4) : null,
          team: m.key === "h2h" || m.key === "spreads" ? o.name : "",
          player: isProp ? o.description || "" : "",
          ou: m.key === "totals" || isProp ? o.name : "",
          ...(o.alt ? { alt: true } : {}),
        });
      }
    }
    if (legs.length) books.push({ key: b.key, name: BOOKS[b.key], legs });
  }
  return books;
}

// ---- parlay math (the page runs the same formulas in the browser) ----
/** Fair parlay chance if the legs are unrelated. */
export const parlayProb = (ps) => ps.reduce((a, p) => a * p, 1);
/** Lowest pre-boost decimal price that breaks even with a profit boost: p × (1 + (D−1)(1+b)) = 1. */
export const breakEvenDec = (p, boost) => 1 + (1 / p - 1) / (1 + boost);
export const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
/** EV of an SGP at American price `price` with profit boost `boost`, against fair chance p. */
export const sgpEv = (price, p, boost) => p * (1 + (dec(price) - 1) * (1 + boost)) - 1;

/** Warnings about legs that work against each other (the fair price above would then be too optimistic). */
export function sgpWarnings(legs) {
  const w = [];
  const sides = legs.filter((l) => l.team);
  if (new Set(sides.map((l) => l.team)).size > 1) w.push("Legs on both teams' moneyline/spread work against each other.");
  const seen = new Map();
  for (const l of legs) {
    const k = `${l.mk}|${l.player}`;
    if (l.ou && seen.has(k) && seen.get(k) !== l.ou) w.push(`Over and Under on the same line (${l.label}).`);
    if (l.ou) seen.set(k, l.ou);
  }
  const tot = legs.find((l) => l.mk === "totals");
  if (tot && legs.some((l) => l.player && l.ou !== tot.ou)) w.push(`Game ${tot.ou} with a player ${tot.ou === "Over" ? "Under" : "Over"} tend to work against each other.`);
  if (legs.some((l) => l.p == null)) w.push("A leg has no fair price (no other book has that number), so it can't be priced.");
  return w;
}

export const THIN_BOOKS = 3; // fewer other books than this at the number = shaky fair price

/**
 * Suggested SGPs at one book. Plain ES5 so the page can run the same function (it's inserted as source).
 * Candidates: legs with a fair price (and minBooks+ other books unless allowThin), the best `pool` by EV. Combos skip legs
 * that clash (two moneyline/spread legs, two legs from the same market line, game total with a player prop the other way).
 * Each combo: { ids, legs, p (fair chance, legs treated as unrelated), combEv ((1+ev1)(1+ev2)... - 1), dec (the legs as a
 * regular parlay at this book), estEv (EV with the boost if the SGP prices like that regular parlay) }.
 * Without promo rules: the best `per` 2-leg and `per` 3-leg combos by combEv.
 * With promo rules (opts.legs = exact leg count and/or opts.minOdds = minimum American price): only combos that meet
 * them (by the regular-parlay price), best `per` by estEv.
 */
export function suggestCombos(legs, opts) {
  opts = opts || {};
  var boost = opts.boost || 0, nLegs = opts.legs || 0, minOdds = opts.minOdds == null ? null : +opts.minOdds;
  var promo = !!(nLegs || minOdds != null);
  var minBooks = opts.allowThin ? 1 : (opts.minBooks || 3), pool = opts.pool || (promo ? 30 : 12), per = opts.per || (promo ? 4 : 3);
  var dec = function (a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
  var minDec = minOdds == null ? 0 : dec(minOdds);
  var cand = legs.filter(function (l) { return l.p != null && l.ev != null && l.n >= minBooks; })
    .sort(function (a, b) { return b.ev - a.ev; }).slice(0, pool);
  function clash(a, b) {
    if (a.team && b.team) return true; // two moneyline/spread legs: same team double-counts, both teams work against each other
    if (a.mk === b.mk && a.player === b.player && !a.team) return true; // same line twice (Over and Under, alt + main, two totals)
    var tot = a.mk === "totals" ? a : b.mk === "totals" ? b : null, other = tot === a ? b : a;
    if (tot && other.player && other.ou && other.ou !== tot.ou) return true;
    return false;
  }
  function make(set) {
    var p = 1, e = 1, d = 1;
    for (var i = 0; i < set.length; i++) { p *= set[i].p; e *= 1 + set[i].ev; d *= dec(set[i].price); }
    return { ids: set.map(function (l) { return l.id; }), legs: set, p: p, combEv: e - 1, dec: d, estEv: p * (1 + (d - 1) * (1 + boost)) - 1 };
  }
  var sizes = nLegs ? [nLegs] : promo ? [2, 3, 4] : [2, 3], maxSize = Math.max.apply(null, sizes), bySize = {};
  sizes.forEach(function (n) { bySize[n] = []; });
  (function walk(start, set) {
    if (set.length >= 2 && bySize[set.length]) { var c = make(set); if (c.dec >= minDec - 1e-9) bySize[set.length].push(c); }
    if (set.length === maxSize) return;
    for (var i = start; i < cand.length; i++) {
      var ok = true;
      for (var j = 0; j < set.length; j++) if (clash(set[j], cand[i])) { ok = false; break; }
      if (ok) walk(i + 1, set.concat([cand[i]]));
    }
  })(0, []);
  if (promo) {
    var all = [];
    sizes.forEach(function (n) { all = all.concat(bySize[n]); });
    return all.sort(function (a, b) { return b.estEv - a.estEv; }).slice(0, per);
  }
  var by = function (a, b) { return b.combEv - a.combEv; };
  return bySize[2].sort(by).slice(0, per).concat(bySize[3].sort(by).slice(0, per));
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const et = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
export const SGP_BOOSTS = [0, 20, 25, 30, 40, 50, 100];
// Leg filter: show legs whose EV is at least this many percent (null = all). Picked legs always stay visible.
export const SGP_FILTERS = [null, -5, -3, 0, 2];
export const DEFAULT_SGP_FILTER = -3;
/** Legs that pass the filter (minEv as a fraction, null = all), plus any already picked. */
export const filterLegs = (legs, minEv, picked = []) =>
  legs.filter((l) => picked.includes(l.id) || minEv == null || (l.ev != null && l.ev >= minEv - 1e-9));

/** /sgp HTML. Either a game list (found) or one game (event + books). */
export function renderSgp({ q = "", found = [], event = null, sport = "", books = [], error = null, token = "", css = "", boost = 30, bookKey = "", minEv = DEFAULT_SGP_FILTER, sort = "ev", pulledAt = null, alt = false, now = Date.now() }) {
  const t = encodeURIComponent(token);
  const head = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a2e1a">
<title>SGP builder</title>
<style>${css}
.search{display:flex;gap:8px;margin:6px 0 14px}.search input{flex:1;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}.chip{font:inherit;font-size:14px;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);min-height:34px}
.chip.on{background:var(--text);color:var(--bg);border-color:var(--text)}.muted{color:var(--muted);font-size:13px}
.games a{display:block;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--text);margin:8px 0;text-decoration:none}
h2{font-size:16px;margin:16px 0 4px}.leg{display:grid;grid-template-columns:1fr auto 58px;gap:8px;align-items:center;width:100%;text-align:left;font:inherit;padding:9px 10px;margin:4px 0;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font-variant-numeric:tabular-nums}
.leg.on{border-color:var(--good);background:color-mix(in srgb,var(--good) 14%,var(--card))}.leg:disabled{opacity:.45}.leg .e{text-align:right}
.pos{color:var(--good);font-weight:600}.neg{color:var(--muted)}
.slip{position:sticky;bottom:0;z-index:6;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin:12px 0 max(12px,env(safe-area-inset-bottom));box-shadow:0 -4px 18px rgba(0,0,0,.08)}
.slip .big{font-size:17px;font-weight:700;margin:2px 0}.slip input{font:inherit;width:110px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
@media (max-width:700px){.slip{bottom:calc(74px + env(safe-area-inset-bottom));margin-bottom:12px}}
.warn{color:#b26a00;font-size:13px;margin-top:4px}@media (prefers-color-scheme:dark){.warn{color:#f0b354}}
.stale{color:#b26a00;font-weight:600}@media (prefers-color-scheme:dark){.stale{color:#f0b354}}a.chip{text-decoration:none;display:inline-flex;align-items:center}
.thin{display:block;font-size:11px;color:#b26a00;font-weight:600}@media (prefers-color-scheme:dark){.thin{color:#f0b354}}
.combo{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:10px;margin:6px 0}.combo .cl{font-size:14px;margin-bottom:4px}
.combo .cm{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
details.sugg>summary{cursor:pointer;font-size:16px;font-weight:700;margin:16px 0 4px}
details.more{margin:4px 0}details.more summary{cursor:pointer;color:var(--muted);font-size:14px;padding:6px 0}
</style></head><body><main>
<header><h1>SGP builder</h1><div class="actions"><a class="btn2" href="/best?token=${t}">Best $</a><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<nav class="bottombar" aria-label="Pages"><a class="btn2" href="/edges?token=${t}">Edges</a><a class="btn2" href="/best?token=${t}">Best $</a></nav>
<form class="search" method="get" action="/sgp"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="boost" value="${boost}"><input type="hidden" name="f" value="${minEv == null ? "all" : minEv}"><input type="hidden" name="o" value="${sort === "group" ? "group" : "ev"}"><input type="hidden" name="alt" value="${alt ? 1 : 0}">
<input name="q" value="${esc(q)}" placeholder="NFL or NBA team" autocapitalize="words"><button type="submit">Find</button></form>`;
  const tail = `</main></body></html>`;
  if (error) return `${head}<div class="err">${esc(error)}</div>${tail}`;
  if (!event) {
    const list = found.length
      ? `<div class="games">${found.map((g) => `<a href="/sgp?token=${t}&s=${g.sport}&e=${encodeURIComponent(g.event.id)}&boost=${boost}&f=${minEv == null ? "all" : minEv}${sort === "group" ? "&o=group" : ""}${alt ? "&alt=1" : ""}"><b>${esc(SPORTS[g.sport])} · ${esc(g.event.away_team)} @ ${esc(g.event.home_team)}</b><br><span class="muted">${et(g.event.commence_time)} ET · about ${alt ? 16 : 7} credits to load</span></a>`).join("")}</div>`
      : q ? `<p class="empty">No upcoming NFL or NBA game found for “${esc(q)}”.</p>` : `<p class="muted">Find a game, then pick your book, your boost and 2–4 legs. Prices each leg against the other books (no-vig) and tells you the lowest SGP price worth taking with your boost.</p>`;
    return `${head}${list}${tail}`;
  }
  const pick = books.find((b) => b.key === bookKey) ? bookKey : (books.find((b) => b.key === "fanduel") || books[0])?.key || "";
  const data = JSON.stringify({ books, boost, book: pick, thin: THIN_BOOKS, minEv: minEv == null ? null : minEv / 100, sort: sort === "group" ? "group" : "ev" }).replace(/</g, "\\u003c");
  return `${head}
<h2 style="font-size:17px">${esc(SPORTS[sport] || sport)} · ${esc(event.away_team)} @ ${esc(event.home_team)}</h2>
<div class="status">${et(event.commence_time)} ET${Date.parse(event.commence_time) <= now ? " · <b>live, prices may be stale</b>" : ""}${pulledAt ? ` · <span id="age" data-at="${pulledAt}">odds pulled just now</span>` : ""}</div>
${pulledAt ? `<div class="chips"><a class="chip" id="refresh" href="#">Refresh odds</a><span class="muted">about ${alt ? 16 : 7} credits; keeps your book, boost and legs</span></div>
<div class="chips"><a class="chip${alt ? " on" : ""}" id="altlines" href="#" aria-pressed="${alt}">Alt lines ${alt ? "on" : "off"}</a><span class="muted">${alt ? "tap to drop them (about 7 credits)" : "tap to load alt spreads, totals and props (about 16 credits)"}</span></div>` : ""}
${books.length ? `<div class="chips" id="books" role="group" aria-label="Book"><span class="muted">Book</span>${books.map((b) => `<button type="button" class="chip" data-k="${b.key}">${esc(b.name)}</button>`).join("")}</div>
<div class="chips" id="boosts" role="group" aria-label="Profit boost"><span class="muted">Boost</span>${SGP_BOOSTS.map((b) => `<button type="button" class="chip" data-b="${b}">${b ? `${b}%` : "None"}</button>`).join("")}</div>
<div class="chips" id="filters" role="group" aria-label="Show legs with EV at least"><span class="muted">Show EV</span>${SGP_FILTERS.map((f) => `<button type="button" class="chip" data-f="${f == null ? "all" : f}">${f == null ? "All" : `≥ ${f > 0 ? "+" : f < 0 ? "−" : ""}${Math.abs(f)}%`}</button>`).join("")}</div>
<div class="chips" id="sorts" role="group" aria-label="Sort legs"><span class="muted">Sort</span><button type="button" class="chip" data-o="ev">Best EV</button><button type="button" class="chip" data-o="group">By market</button></div>
<div class="chips"><button type="button" class="chip" id="thin" aria-pressed="false">Need ${THIN_BOOKS}+ books</button><span class="muted">hides legs whose fair price comes from fewer books</span></div>
<div class="muted">Each leg: that book's price and its EV vs the other books' no-vig price. Tap 2–4 legs.</div>
<div class="chips" id="pn" role="group" aria-label="Promo: number of legs"><span class="muted">Promo legs</span>${["", 2, 3, 4].map((n) => `<button type="button" class="chip" data-n="${n}">${n || "Any"}</button>`).join("")}</div>
<div class="chips" id="pm" role="group" aria-label="Promo: minimum odds"><span class="muted">Min odds</span>${["", 100, 200, 300].map((m) => `<button type="button" class="chip" data-m="${m}">${m ? `+${m}` : "None"}</button>`).join("")}<input id="pmx" inputmode="numeric" placeholder="+450" aria-label="Custom minimum odds" style="font:inherit;width:76px;padding:6px 8px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--text)"></div>
<div id="sugg"></div>
<div id="legs"></div>
<div class="slip" id="slip" hidden></div>
<script>
(function(){
var D=${data}, sel=[]; D.need=true; D.pn=0; D.pm=null;
try{var U0=new URL(location.href), l0=U0.searchParams.get("l"); D.pn=+(U0.searchParams.get("pn")||0)||0; var pm0=U0.searchParams.get("pm"); D.pm=pm0?+pm0:null; if(l0)sel=l0.split("~").filter(Boolean); var b0=U0.searchParams.get("b"); if(b0&&D.books.some(function(x){return x.key===b0}))D.book=b0}catch(e){}
var suggestCombos=${suggestCombos.toString()};
var dec=function(a){return a>0?1+a/100:1+100/-a}, am=function(d){return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1))};
var sg=function(n){return n>0?"+"+n:""+n}, pct=function(e){return (e>0?"+":"")+(e*100).toFixed(1)+"%"};
var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return "&#"+c.charCodeAt(0)+";"})};
var NAMES={h2h:"Moneyline",spreads:"Spread",totals:"Total"};
function book(){return D.books.find(function(b){return b.key===D.book})}
function chips(){
  document.querySelectorAll("#books .chip").forEach(function(c){var on=c.dataset.k===D.book;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll("#boosts .chip").forEach(function(c){var on=+c.dataset.b===D.boost;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  sugg();
  document.querySelectorAll("#pn .chip").forEach(function(c){var on=(+c.dataset.n||0)===D.pn;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  var custom=D.pm!=null&&[100,200,300].indexOf(D.pm)<0;
  document.querySelectorAll("#pm .chip").forEach(function(c){var v=c.dataset.m===""?null:+c.dataset.m;var on=!custom&&v===D.pm;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  var px2=document.getElementById("pmx"); if(px2&&document.activeElement!==px2)px2.value=custom?sg(D.pm):"";
  var th=document.getElementById("thin"); if(th){th.classList.toggle("on",D.need);th.setAttribute("aria-pressed",D.need)}
  document.querySelectorAll("#sorts .chip").forEach(function(c){var on=c.dataset.o===D.sort;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll("#filters .chip").forEach(function(c){var f=c.dataset.f==="all"?null:+c.dataset.f/100;var on=f===D.minEv||(f!=null&&D.minEv!=null&&Math.abs(f-D.minEv)<1e-9);c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
}
function shown(l){return sel.indexOf(l.id)>=0||((!D.need||l.p==null||l.n>=D.thin)&&(D.minEv==null||(l.ev!=null&&l.ev>=D.minEv-1e-9)))}
function sugg(){
  var box=document.getElementById("sugg"), b=book(); if(!b){box.innerHTML="";return}
  var bo=D.boost/100, promo=!!(D.pn||D.pm!=null);
  var list=suggestCombos(b.legs,{allowThin:!D.need,minBooks:D.thin,boost:bo,legs:D.pn,minOdds:D.pm,per:promo?4:2});
  var rule=promo?[D.pn?D.pn+" legs":"",D.pm!=null?sg(D.pm)+" or longer":""].filter(Boolean).join(", "):"";
  var title=promo?"Best "+(D.pn?D.pn+"-leg ":"")+"SGPs at "+esc(b.name)+(D.pm!=null?", "+sg(D.pm)+" or longer":""):"Suggested SGPs at "+esc(b.name)+" <span class='muted'>(best legs that don't clash)</span>";
  if(!list.length){box.innerHTML=promo?"<h2>"+title+"</h2><p class='muted'>No combo of legs that pass your filters reaches "+esc(rule)+". Try Alt lines on, Need 3+ books off, or a lower filter.</p>":"";return}
  var open=sugg.open!==false;
  box.innerHTML="<details class='sugg'"+(open?" open":"")+"><summary>"+title+"</summary>"+list.map(function(c,i){
    var be=1+(1/c.p-1)/(1+bo);
    return "<div class='combo'><div class='cl'>"+c.legs.map(function(l){return esc(l.label)+(l.alt?" <small class='muted'>alt</small>":"")+" <b>"+sg(l.price)+"</b>"}).join(" + ")+"</div>"+
      "<div class='cm'><span class='muted'>"+(promo?"as a parlay "+sg(am(c.dec))+" · est. EV"+(D.boost?" with boost":"")+" <span class='"+(c.estEv>0?"pos":"neg")+"'>"+pct(c.estEv)+"</span> · ":"legs EV "+pct(c.combEv)+" · ")+
      "fair "+sg(am(1/c.p))+" · <b>worth it at "+sg(am(be))+"+</b>"+(D.boost?" before boost":"")+"</span><button type='button' class='chip' data-c='"+i+"'>Use</button></div></div>";
  }).join("")+(promo?"<div class='muted' style='margin:4px 0'>Est. EV assumes "+esc(b.name)+"'s SGP price matches the regular-parlay price; real SGP prices are often shorter. The test is the app: bet only if the SGP price reaches the <b>worth it at</b> number and the promo minimum.</div>":"")+"</details>";
  box.querySelector("details").addEventListener("toggle",function(e){sugg.open=e.target.open});
  box.querySelectorAll("[data-c]").forEach(function(btn){btn.addEventListener("click",function(){
    sel=list[+btn.dataset.c].ids.slice(); legs(); slip(); document.getElementById("slip").scrollIntoView({behavior:"smooth",block:"end"});
  })});
}
function setPromo(){chips();
  try{var u=new URL(location.href); D.pn?u.searchParams.set("pn",D.pn):u.searchParams.delete("pn"); D.pm!=null?u.searchParams.set("pm",D.pm):u.searchParams.delete("pm"); history.replaceState(null,"",u)}catch(e){}}
function fl(){return D.minEv==null?"":"EV ≥ "+(D.minEv>0?"+":D.minEv<0?"−":"")+Math.abs(Math.round(D.minEv*100))+"%"}
function legBtn(l){
  var on=sel.indexOf(l.id)>=0, thin=l.p!=null&&l.n<D.thin;
  return '<button type="button" class="leg'+(on?' on':'')+'" data-id="'+esc(l.id)+'"'+(l.p==null?' disabled title="no other book has this number"':'')+' aria-pressed="'+on+'"><span>'+esc(l.label)+(l.alt?'<small class="muted"> alt</small>':'')+(thin?'<small class="thin">fair from '+l.n+' book'+(l.n>1?'s':'')+' only</small>':'')+'</span><b>'+sg(l.price)+'</b><span class="e '+(l.ev>0?'pos':'neg')+'">'+(l.ev==null?'—':pct(l.ev))+'</span></button>';
}
function legs(){
  var b=book(); if(!b){document.getElementById("legs").innerHTML="";return}
  var vis=b.legs.filter(shown), hidden=b.legs.length-vis.length;
  var more=function(list,n,what){return list.length>n?"<details class='more'><summary>"+(list.length-n)+" more "+what+"</summary>"+list.slice(n).join("")+"</details>":""};
  var byEv=function(a,c){return (c.ev==null?-9:c.ev)-(a.ev==null?-9:a.ev)};
  var html="";
  if(D.sort==="ev"){
    // one list, every market, best EV first
    var rows=vis.slice().sort(byEv).map(legBtn);
    html="<h2>All legs <span class='muted'>(best EV first)</span></h2>"+rows.slice(0,20).join("")+more(rows,20,"legs");
  } else {
    var groups={}; vis.forEach(function(l){if(!l.player)(groups[NAMES[l.mk]]=groups[NAMES[l.mk]]||[]).push(l)});
    html=["Moneyline","Spread","Total"].filter(function(g){return groups[g]}).map(function(g){return "<h2>"+g+"</h2>"+groups[g].map(legBtn).join("")}).join("");
    var props=vis.filter(function(l){return l.player}), pg={};
    props.forEach(function(l){(pg[l.player]=pg[l.player]||[]).push(l)});
    var players=Object.keys(pg).sort(function(a,c){var best=function(g){return Math.max.apply(null,pg[g].map(function(l){return l.ev==null?-9:l.ev}))};return best(c)-best(a)});
    var blocks=players.map(function(g){return pg[g].map(legBtn).join("")});
    if(blocks.length)html+="<h2>Player props <span class='muted'>(by player, best-priced first)</span></h2>"+blocks.slice(0,8).join("")+more(blocks,8,"players");
  }
  if(!vis.length)html="<p class='empty'>No legs at "+esc(b.name)+" with "+fl()+". Try a lower filter or another book.</p>";
  if(hidden)html+="<div class='muted' style='margin:8px 0'>"+hidden+" leg"+(hidden>1?"s":"")+" hidden ("+fl()+" filter). <button type='button' class='chip' id='showall'>Show all</button></div>";
  document.getElementById("legs").innerHTML=html;
  document.querySelectorAll(".leg").forEach(function(el){el.addEventListener("click",function(){
    var id=el.dataset.id,i=sel.indexOf(id); if(i>=0)sel.splice(i,1); else if(sel.length<6)sel.push(id); legs(); slip();
  })});
  var sa=document.getElementById("showall"); if(sa)sa.addEventListener("click",function(){setF(null)});
}
function setO(o){D.sort=o;chips();legs();
  try{var u=new URL(location.href);u.searchParams.set("o",o);history.replaceState(null,"",u)}catch(e){}}
function setF(f){D.minEv=f;chips();legs();
  try{var u=new URL(location.href);u.searchParams.set("f",f==null?"all":Math.round(f*100));history.replaceState(null,"",u)}catch(e){}}
function warnings(L){
  var w=[], teams={}; L.forEach(function(l){if(l.team)teams[l.team]=1});
  if(Object.keys(teams).length>1)w.push("Legs on both teams' moneyline/spread work against each other.");
  var seen={}; L.forEach(function(l){var k=l.mk+"|"+l.player; if(l.ou&&seen[k]&&seen[k]!==l.ou)w.push("Over and Under on the same line ("+l.label+")."); if(l.ou)seen[k]=l.ou});
  var tot=L.find(function(l){return l.mk==="totals"});
  if(tot&&L.some(function(l){return l.player&&l.ou!==tot.ou}))w.push("Game "+tot.ou+" with a player "+(tot.ou==="Over"?"Under":"Over")+" tend to work against each other.");
  return w;
}
function slip(){
  var box=document.getElementById("slip"), b=book();
  var L=b?b.legs.filter(function(l){return sel.indexOf(l.id)>=0}):[];
  if(!L.length){box.hidden=true;return}
  box.hidden=false;
  var p=L.reduce(function(a,l){return a*l.p},1), bo=D.boost/100;
  var naive=L.reduce(function(a,l){return a*dec(l.price)},1);
  var be=1+(1/p-1)/(1+bo);
  var html="<div class='muted'>"+L.length+" leg"+(L.length>1?"s":"")+" at "+esc(b.name)+(D.boost?" · "+D.boost+"% boost":"")+"</div>";
  if(L.length<2){html+="<div class='muted'>Pick at least one more leg.</div>"}
  else{
    html+="<div class='big'>Worth it if "+esc(b.name)+" shows "+sg(am(be))+" or better"+(D.boost?" before the boost":"")+"</div>";
    html+="<div class='muted'>Fair "+sg(am(1/p))+" (legs treated as unrelated) · these legs as a regular parlay: "+sg(am(naive))+"</div>";
    html+="<div style='margin-top:8px'><label class='muted'>"+esc(b.name)+"'s SGP price <input id='px' inputmode='numeric' placeholder='+450' value='"+(slip.px||"")+"'></label> <span id='out'></span></div>";
    warnings(L).forEach(function(t){html+="<div class='warn'>⚠ "+esc(t)+"</div>"});
  }
  html+="<div style='margin-top:6px'><button type='button' class='chip' id='clr'>Clear legs</button></div>";
  box.innerHTML=html;
  var px=document.getElementById("px");
  if(px){var upd=function(){slip.px=px.value;var a=parseFloat(px.value.replace(/[^0-9.+-]/g,""));var o=document.getElementById("out");
    if(!isFinite(a)||Math.abs(a)<100){o.innerHTML="";return}
    var d=1+(dec(a)-1)*(1+bo), e=p*d-1; o.innerHTML=(D.boost?"→ "+sg(am(d))+" · ":"")+"<span class='"+(e>0?"pos":"neg")+"'>"+pct(e)+" EV</span>"};
    px.addEventListener("input",upd); upd();}
  document.getElementById("clr").addEventListener("click",function(){sel=[];legs();slip()});
}
document.querySelectorAll("#books .chip").forEach(function(c){c.addEventListener("click",function(){
  var prev=book(), ids=prev?prev.legs.filter(function(l){return sel.indexOf(l.id)>=0}).map(function(l){return l.id}):[];
  D.book=c.dataset.k; var nb=book(); sel=ids.filter(function(id){return nb.legs.some(function(l){return l.id===id&&l.p!=null})});
  chips();legs();slip();
})});
document.querySelectorAll("#boosts .chip").forEach(function(c){c.addEventListener("click",function(){D.boost=+c.dataset.b;chips();slip();
  try{var u=new URL(location.href);u.searchParams.set("boost",D.boost);history.replaceState(null,"",u)}catch(e){}})});
document.querySelectorAll("#sorts .chip").forEach(function(c){c.addEventListener("click",function(){setO(c.dataset.o)})});
document.getElementById("thin").addEventListener("click",function(){D.need=!D.need;chips();legs()});
document.querySelectorAll("#pn .chip").forEach(function(c){c.addEventListener("click",function(){D.pn=+c.dataset.n||0;setPromo()})});
document.querySelectorAll("#pm .chip").forEach(function(c){c.addEventListener("click",function(){D.pm=c.dataset.m===""?null:+c.dataset.m;setPromo()})});
document.getElementById("pmx").addEventListener("change",function(e){var a=parseFloat(String(e.target.value).replace(/[^0-9.+-]/g,""));D.pm=isFinite(a)&&Math.abs(a)>=100?Math.round(a):null;setPromo()});
document.querySelectorAll("#filters .chip").forEach(function(c){c.addEventListener("click",function(){setF(c.dataset.f==="all"?null:+c.dataset.f/100)})});
(function(){var b=book(); if(b)sel=sel.filter(function(id){return b.legs.some(function(l){return l.id===id&&l.p!=null})}).slice(0,6)})();
(function(){
  var age=document.getElementById("age"), r=document.getElementById("refresh");
  function tick(){ if(!age)return; var m=Math.floor((Date.now()-+age.dataset.at)/60000);
    age.textContent=m<1?"odds pulled just now":"odds pulled "+m+" min ago"+(m>=5?" — refresh before betting":"");
    age.className=m>=5?"stale":""; }
  tick(); setInterval(tick,30000);
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")tick()});
  var al=document.getElementById("altlines");
  if(al)al.addEventListener("click",function(e){e.preventDefault();
    var u=new URL(location.href); u.searchParams.set("alt",${alt ? 0 : 1}); u.searchParams.set("b",D.book); u.searchParams.set("boost",D.boost);
    if(sel.length)u.searchParams.set("l",sel.join("~")); else u.searchParams.delete("l");
    al.textContent="Loading…"; location.href=u.toString();});
  if(r)r.addEventListener("click",function(e){e.preventDefault();
    var u=new URL(location.href); u.searchParams.set("fresh","1"); u.searchParams.set("b",D.book); u.searchParams.set("boost",D.boost);
    if(sel.length)u.searchParams.set("l",sel.join("~")); else u.searchParams.delete("l");
    r.textContent="Refreshing…"; location.href=u.toString();});
  // after a refresh, drop fresh=1 from the address so a reload doesn't spend credits again
  try{var u=new URL(location.href); if(u.searchParams.has("fresh")){u.searchParams.delete("fresh");history.replaceState(null,"",u)}}catch(e){}
})();
chips();legs();slip();
})();
</script>` : `<p class="empty">No prices from your books for this game yet.</p>`}
${tail}`;
}
