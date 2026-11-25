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
export const sgpMarkets = (sport) => ["h2h", "spreads", "totals", ...(SGP_PROPS[sport] || [])].join(",");

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
  const books = [];
  for (const b of event?.bookmakers || []) {
    if (!BOOKS[b.key] || skipBooks.has(b.key)) continue;
    const legs = [];
    for (const m of b.markets || []) {
      if (!markets.includes(m.key)) continue;
      for (const o of m.outcomes || []) {
        if (!Number.isFinite(o.price) || o.price < minOdds || o.price > maxOdds) continue;
        const c = consensusProb(event.bookmakers, m.key, o, b.key, 1);
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
export function renderSgp({ q = "", found = [], event = null, sport = "", books = [], error = null, token = "", css = "", boost = 30, bookKey = "", minEv = DEFAULT_SGP_FILTER, sort = "ev", now = Date.now() }) {
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
.warn{color:#b26a00;font-size:13px;margin-top:4px}@media (prefers-color-scheme:dark){.warn{color:#f0b354}}
details.more{margin:4px 0}details.more summary{cursor:pointer;color:var(--muted);font-size:14px;padding:6px 0}
</style></head><body><main>
<header><h1>SGP builder</h1><div class="actions"><a class="btn2" href="/best?token=${t}">Best $</a><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<form class="search" method="get" action="/sgp"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="boost" value="${boost}"><input type="hidden" name="f" value="${minEv == null ? "all" : minEv}"><input type="hidden" name="o" value="${sort === "group" ? "group" : "ev"}">
<input name="q" value="${esc(q)}" placeholder="NFL or NBA team" autocapitalize="words"><button type="submit">Find</button></form>`;
  const tail = `</main></body></html>`;
  if (error) return `${head}<div class="err">${esc(error)}</div>${tail}`;
  if (!event) {
    const list = found.length
      ? `<div class="games">${found.map((g) => `<a href="/sgp?token=${t}&s=${g.sport}&e=${encodeURIComponent(g.event.id)}&boost=${boost}&f=${minEv == null ? "all" : minEv}${sort === "group" ? "&o=group" : ""}"><b>${esc(SPORTS[g.sport])} · ${esc(g.event.away_team)} @ ${esc(g.event.home_team)}</b><br><span class="muted">${et(g.event.commence_time)} ET · about 7 credits to load</span></a>`).join("")}</div>`
      : q ? `<p class="empty">No upcoming NFL or NBA game found for “${esc(q)}”.</p>` : `<p class="muted">Find a game, then pick your book, your boost and 2–4 legs. Prices each leg against the other books (no-vig) and tells you the lowest SGP price worth taking with your boost.</p>`;
    return `${head}${list}${tail}`;
  }
  const pick = books.find((b) => b.key === bookKey) ? bookKey : (books.find((b) => b.key === "fanduel") || books[0])?.key || "";
  const data = JSON.stringify({ books, boost, book: pick, minEv: minEv == null ? null : minEv / 100, sort: sort === "group" ? "group" : "ev" }).replace(/</g, "\\u003c");
  return `${head}
<h2 style="font-size:17px">${esc(SPORTS[sport] || sport)} · ${esc(event.away_team)} @ ${esc(event.home_team)}</h2>
<div class="status">${et(event.commence_time)} ET${Date.parse(event.commence_time) <= now ? " · <b>live, prices may be stale</b>" : ""}</div>
${books.length ? `<div class="chips" id="books" role="group" aria-label="Book"><span class="muted">Book</span>${books.map((b) => `<button type="button" class="chip" data-k="${b.key}">${esc(b.name)}</button>`).join("")}</div>
<div class="chips" id="boosts" role="group" aria-label="Profit boost"><span class="muted">Boost</span>${SGP_BOOSTS.map((b) => `<button type="button" class="chip" data-b="${b}">${b ? `${b}%` : "None"}</button>`).join("")}</div>
<div class="chips" id="filters" role="group" aria-label="Show legs with EV at least"><span class="muted">Show EV</span>${SGP_FILTERS.map((f) => `<button type="button" class="chip" data-f="${f == null ? "all" : f}">${f == null ? "All" : `≥ ${f > 0 ? "+" : f < 0 ? "−" : ""}${Math.abs(f)}%`}</button>`).join("")}</div>
<div class="chips" id="sorts" role="group" aria-label="Sort legs"><span class="muted">Sort</span><button type="button" class="chip" data-o="ev">Best EV</button><button type="button" class="chip" data-o="group">By market</button></div>
<div class="muted">Each leg: that book's price and its EV vs the other books' no-vig price. Tap 2–4 legs.</div>
<div id="legs"></div>
<div class="slip" id="slip" hidden></div>
<script>
(function(){
var D=${data}, sel=[];
var dec=function(a){return a>0?1+a/100:1+100/-a}, am=function(d){return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1))};
var sg=function(n){return n>0?"+"+n:""+n}, pct=function(e){return (e>0?"+":"")+(e*100).toFixed(1)+"%"};
var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){return "&#"+c.charCodeAt(0)+";"})};
var NAMES={h2h:"Moneyline",spreads:"Spread",totals:"Total"};
function book(){return D.books.find(function(b){return b.key===D.book})}
function chips(){
  document.querySelectorAll("#books .chip").forEach(function(c){var on=c.dataset.k===D.book;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll("#boosts .chip").forEach(function(c){var on=+c.dataset.b===D.boost;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll("#sorts .chip").forEach(function(c){var on=c.dataset.o===D.sort;c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
  document.querySelectorAll("#filters .chip").forEach(function(c){var f=c.dataset.f==="all"?null:+c.dataset.f/100;var on=f===D.minEv||(f!=null&&D.minEv!=null&&Math.abs(f-D.minEv)<1e-9);c.classList.toggle("on",on);c.setAttribute("aria-pressed",on)});
}
function shown(l){return sel.indexOf(l.id)>=0||D.minEv==null||(l.ev!=null&&l.ev>=D.minEv-1e-9)}
function fl(){return D.minEv==null?"":"EV ≥ "+(D.minEv>0?"+":D.minEv<0?"−":"")+Math.abs(Math.round(D.minEv*100))+"%"}
function legBtn(l){
  var on=sel.indexOf(l.id)>=0;
  return '<button type="button" class="leg'+(on?' on':'')+'" data-id="'+esc(l.id)+'"'+(l.p==null?' disabled title="no other book has this number"':'')+' aria-pressed="'+on+'"><span>'+esc(l.label)+'</span><b>'+sg(l.price)+'</b><span class="e '+(l.ev>0?'pos':'neg')+'">'+(l.ev==null?'—':pct(l.ev))+'</span></button>';
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
document.querySelectorAll("#filters .chip").forEach(function(c){c.addEventListener("click",function(){setF(c.dataset.f==="all"?null:+c.dataset.f/100)})});
chips();legs();slip();
})();
</script>` : `<p class="empty">No prices from your books for this game yet.</p>`}
${tail}`;
}
