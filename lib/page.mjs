// HTML for the /edges page. Pure function so it can be tested without Netlify.
import { BOOKS, PROP_CATALOG, PROP_LABELS, SPORTS, checkUrl, gradeFor, needsVerify, openLink, stakeFor } from "./scan.mjs";
const flagHtml = (flags) => (flags || []).map((f) => `<div class="flag ${f.level}">${esc(f.text)}</div>`).join("");
const FLAG_CSS = `.flag{margin-top:4px;font-size:13px;font-weight:600}.flag.conflict{color:var(--hot)}.flag.opposite{color:#b26a00}
.flag.same{color:var(--good)}.flag.event{color:var(--muted);font-weight:400}
@media (prefers-color-scheme:dark){.flag.opposite{color:#f0b354}}`;


const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);
const et = (t, opts) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", ...opts });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};

export const CSS = `:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5d6570;--line:#e3e6ea;--good:#0a7a3f;--hot:#b3261e;--btn:#15181d;--btntext:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaed;--muted:#9aa2ad;--line:#2a2f37;--good:#4cc38a;--hot:#ff7b72;--btn:#e8eaed;--btntext:#0f1115}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}h1{font-size:20px;margin:4px 0}
.status{color:var(--muted);font-size:13px;margin-bottom:14px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.top{display:flex;justify-content:space-between;gap:12px;font-size:16px}.pick{font-weight:500}
.ev{color:var(--good);font-weight:700;white-space:nowrap}li.hot .ev{color:var(--hot)}
${FLAG_CSS}
h2{font-size:16px;margin:22px 0 10px}ul.recent li{padding:10px 14px}ul.recent .pick{font-size:15px}
.verify{margin-top:4px;color:var(--hot);font-weight:600;font-size:14px}.mid{margin-top:4px}a.open{display:inline-block;margin-top:8px;font-weight:600;font-size:14px;color:var(--btntext);background:var(--btn);border-radius:8px;padding:6px 12px;text-decoration:none}a.open.alt{background:var(--card);color:var(--text);border:1px solid var(--line)}.sub{margin-top:2px;color:var(--muted);font-size:13px}
.empty{color:var(--muted);padding:24px 0;text-align:center}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
form{margin:0}button{font:inherit;font-weight:600;font-size:15px;border:0;border-radius:10px;padding:9px 14px;background:var(--btn);color:var(--btntext);cursor:pointer}
button:disabled{opacity:.6}
.notice{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-bottom:12px;font-size:14px}
.err{color:var(--hot);font-size:13px;margin:-8px 0 12px}
header .actions{display:flex;gap:8px}a.btn2,button.btn2{font:inherit;font-weight:600;font-size:15px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--card);color:var(--text);text-decoration:none}
fieldset{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px 12px;margin:0 0 12px}
legend{font-weight:600;padding:0 4px}.hint{color:var(--muted);font-size:13px;margin:2px 0 8px}
label.chk{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--line)}label.chk:first-of-type{border-top:0}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--good)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}
input[type=number],select{font:inherit;width:96px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.save{display:flex;gap:10px;align-items:center;margin-top:4px}
`;

export function renderEdges({ edges, state, lastRun, now = Date.now(), token = "", scanned = false, shortcutBooks = new Set(), flagsFor = () => [], alerts = [] }) {
  const sports = Object.values(edges || {});
  const rows = sports
    .flatMap((s) => s.hits.map((h) => ({ ...h, pulledAt: s.at })))
    .filter((h) => Date.parse(h.start) > now)
    .sort((a, b) => b.ev - a.ev);

  const cards = rows.map((h) => {
    const pin = h.betterLine
      ? `Pin ${h.market === "spreads" && h.pinPoint > 0 ? "+" : ""}${h.pinPoint} ${fmt(h.pinPrice)} · better number`
      : `Pin ${fmt(h.pinPrice)}`;
    const href = openLink(h.bookKey, h.link, shortcutBooks);
    const chk = checkUrl("", token, h, h.pulledAt);
    const open = [
      chk ? `<a class="open" href="${esc(chk)}">Check price</a>` : "",
      href ? `<a class="${chk ? "open alt" : "open"}" href="${esc(href)}" target="_blank" rel="noopener">Open ${esc(h.book)}</a>` : "",
    ].join(" ");
    return `<li class="${h.ev >= 0.05 ? "hot" : ""}">
  <div class="top"><span class="pick">${esc(h.pick)} <b>${fmt(h.odds)}</b></span><span class="ev">${h.betterLine ? "≥" : ""}+${(h.ev * 100).toFixed(1)}%</span></div>
  <div class="mid">${esc(h.book)} · fair ${fmt(h.fair)} · ${esc(pin)} · <b>Grade ${gradeFor(h)} · stake $${stakeFor(h)}</b></div>
  ${needsVerify(h) ? `<div class="verify">VERIFY: stale Pinnacle / injury?</div>` : ""}
  ${flagHtml(flagsFor(h))}
  <div class="sub">${esc(h.sport)} · ${esc(h.game)} · ${et(h.start, { weekday: "short", hour: "numeric", minute: "2-digit" })} ET · seen ${ago(now - h.pulledAt)}</div>
  ${open}
</li>`;
  });

  // Alerts already sent for games that haven't started. Ones the latest scan no longer finds are marked,
  // so an alert can always be found and re-checked live.
  const openKeys = new Set(rows.map((h) => h.key));
  const recent = (alerts || []).filter((a) => Date.parse(a.start) > now);
  const recentHtml = recent.length ? `<h2>Recent alerts</h2><ul class="recent">${recent.map((a) => {
    const chk = checkUrl("", token, a, a.alertedAt);
    const live = openKeys.has(a.key);
    return `<li>
  <div class="top"><span class="pick">${esc(a.pick)} <b>${fmt(a.odds)}</b> <small>@ ${esc(a.book)}</small></span><span class="ev">${a.betterLine ? "≥" : ""}+${(a.ev * 100).toFixed(1)}%</span></div>
  <div class="sub">${esc(a.sport)} · ${esc(a.game)} · ${et(a.start, { weekday: "short", hour: "numeric", minute: "2-digit" })} ET · alerted ${ago(now - a.alertedAt)} · ${live ? "still in latest scan" : "<b>not in latest scan</b>"}</div>
  ${flagHtml(flagsFor(a))}
  ${chk ? `<a class="open" href="${esc(chk)}">Check price</a>` : ""}
</li>`;
  }).join("\n")}</ul>` : "";

  const status = [
    lastRun?.at ? `Last run ${ago(now - Date.parse(lastRun.at))}${lastRun.skipped ? ` (${esc(lastRun.skipped)})` : ""}` : "No runs yet",
    state?.remaining != null ? `${state.remaining} Odds API credits` : "",
  ].filter(Boolean).join(" · ");

  // Problems from the last run (API errors), so a manual scan shows what went wrong.
  const errors = Object.entries({ ...(lastRun?.sports || {}), ...(lastRun?.props || {}) })
    .filter(([, v]) => /^error/.test(v))
    .map(([k, v]) => `${esc(SPORTS[k] || k)}: ${esc(v.replace(/^error: /, ""))} · Odds API problem, retries next scan`);
  const n = lastRun?.newHits?.length || 0;
  const notice = scanned
    ? `<div class="notice">Scan done · ${n ? `${n} new alert${n > 1 ? "s" : ""} sent` : "no new alerts"}</div>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Edges"><meta name="theme-color" content="#0a2e1a">
<title>Open edges</title>
<style>${CSS}</style></head><body><main>
<header><h1>Open edges</h1><div class="actions">
<a class="btn2" href="/best?token=${encodeURIComponent(token)}" aria-label="Best price lookup">Best $</a>
<a class="btn2" href="/settings?token=${encodeURIComponent(token)}">Settings</a>
<form method="post" action="/edges?token=${encodeURIComponent(token)}" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Scanning…'">
<button type="submit">Scan now</button></form></div></header>
<div class="status">${status}</div>
${errors.length ? `<div class="err">${errors.join("<br>")}</div>` : ""}
${notice}
${rows.length ? `<ul>${cards.join("\n")}</ul>` : `<p class="empty">No open edges right now.</p>`}
${recentHtml}
</main></body></html>`;
}

const HOURS = Array.from({ length: 25 }, (_, h) => [h, h === 0 || h === 24 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`]);
const chk = (name, label, on) =>
  `<label class="chk"><input type="checkbox" name="${name}"${on ? " checked" : ""}> ${esc(label)}</label>`;

/** Settings form. `cur` comes from currentSettings(); `custom` = settings have been saved from this page. */
export function renderSettings({ cur, token = "", saved = false, custom = false }) {
  const t = encodeURIComponent(token);
  const hourLabel = (h) => (HOURS.find(([x]) => x === h) || [, `${h}`])[1];
  const hourSel = (name, val, lo, hi) =>
    `<select name="${name}">${HOURS.filter(([h]) => h >= lo && h <= hi)
      .map(([h, l]) => `<option value="${h}"${h === val ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const pctIn = (name, v) => `<input type="number" name="${name}" step="0.5" min="0" max="50" value="${+(v * 100).toFixed(2)}">`;
  const minIn = (name, v, max = 240) => `<input type="number" name="${name}" step="5" min="5" max="${max}" value="${v}">`;
  const toggle = (name, on, label = "") =>
    `<label class="tog"><input type="checkbox" name="${name}"${on ? " checked" : ""}>${label ? ` <span>${esc(label)}</span>` : ""}</label>`;
  const section = (title, summary, body) =>
    `<details><summary><span class="st">${title}</span><span class="sum">${summary}</span></summary><div class="body">${body}</div></details>`;
  const pct = (v) => `${+(v * 100).toFixed(1)}%`;

  const booksOn = Object.keys(BOOKS).filter((k) => !cur.booksOff.has(k));
  const sportsOn = Object.keys(SPORTS).filter((k) => cur.sports.has(k));
  const propsOn = Object.keys(PROP_CATALOG).filter((k) => cur.propSports.has(k));

  const alerts = section(
    "Alerts",
    `ML ${pct(cur.minEvMl)} · Spr ${pct(cur.minEvSpread)} · Tot ${pct(cur.minEvTotal)} · Props ${pct(cur.propMinEv)}`,
    `<div class="hint">Alert when EV is at least:</div>
<div class="grid2">
<label class="cell"><span>Moneylines</span><span>${pctIn("min_ev_ml", cur.minEvMl)} %</span></label>
<label class="cell"><span>Spreads</span><span>${pctIn("min_ev_spread", cur.minEvSpread)} %</span></label>
<label class="cell"><span>Totals</span><span>${pctIn("min_ev_total", cur.minEvTotal)} %</span></label>
<label class="cell"><span>Props</span><span>${pctIn("prop_min_ev", cur.propMinEv)} %</span></label>
</div>
<div class="row"><span>Separate alerts per scan <small>(rest go in one summary)</small></span><span><input type="number" name="max_each" step="1" min="1" max="20" value="${cur.maxEach}"></span></div>
<div class="row"><span>Delete alerts after <small>(0 = keep)</small></span><span><input type="number" name="ttl" step="1" min="0" max="240" value="${cur.ttl}"> min</span></div>`
  );

  const books = section(
    "Books",
    `${booksOn.length} of ${Object.keys(BOOKS).length} on${cur.shortcutBooks.size ? ` · ${cur.shortcutBooks.size} via Shortcut` : ""}`,
    `<div class="btable"><div class="bh"><span></span><span>On</span><span>Shortcut</span></div>
${Object.entries(BOOKS).map(([k, l]) => `<div class="br"><span>${esc(l)}</span>${toggle(`book_${k}`, !cur.booksOff.has(k))}${toggle(`sc_${k}`, cur.shortcutBooks.has(k))}</div>`).join("\n")}
</div>
<div class="hint">Off: the book is ignored and the next-best book takes the alert.<br>
Shortcut: for apps whose links open Safari (BetRivers). Make an iPhone Shortcut named "Open BetRivers" (etc.)
with one action, Open App → that book.</div>`
  );

  const sports = section(
    "Sports &amp; props",
    `${sportsOn.map((k) => SPORTS[k]).join(", ") || "none"}${propsOn.length ? ` · props: ${propsOn.map((k) => SPORTS[k]).join(", ")}` : ""}`,
    `<div class="chips">${Object.entries(SPORTS).map(([k, l]) => `<label class="chip"><input type="checkbox" name="sport_${k}"${cur.sports.has(k) ? " checked" : ""}> ${esc(l)}</label>`).join("")}</div>
${Object.entries(PROP_CATALOG).map(([sp, markets]) => `<div class="propgrp">
${toggle(`props_${sp}`, cur.propSports.has(sp), `${SPORTS[sp]} player props`)}
<div class="chips small">${Object.entries(markets).map(([k, [, name]]) => `<label class="chip"><input type="checkbox" name="prop_${k}"${cur.propMarkets.has(k) ? " checked" : ""}> ${esc(name)}</label>`).join("")}</div>
</div>`).join("\n")}
<div class="hint">Each prop type costs about 1 credit per game per check.</div>`
  );

  const schedule = section(
    "Schedule",
    `${hourLabel(cur.start)}–${hourLabel(cur.end)} ET · ${cur.tipMin}/${cur.nearMin}/${cur.farMin} min · props ${cur.propMin} min`,
    `<div class="row"><span>Scan from</span><span>${hourSel("start", cur.start, 0, 23)} to ${hourSel("end", cur.end, 1, 24)}</span></div>
<div class="hint">How often to check a sport (minutes, 5 is fastest). Faster uses more credits: 3 per sport per check.</div>
<div class="row"><span>Game within 1 hour</span><span>${minIn("tip_min", cur.tipMin)} min</span></div>
<div class="row"><span>Game within 4 hours</span><span>${minIn("near_min", cur.nearMin)} min</span></div>
<div class="row"><span>Further out</span><span>${minIn("far_min", cur.farMin, 480)} min</span></div>
<div class="row"><span>Player props</span><span>${minIn("prop_min", cur.propMin, 480)} min</span></div>
<div class="row"><span>Start props</span><span><input type="number" name="prop_window" step="1" min="1" max="36" value="${cur.propWindow}"> h before</span></div>`
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Edges"><meta name="theme-color" content="#0a2e1a">
<title>Line alert settings</title>
<style>${CSS}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px}
summary{list-style:none;cursor:pointer;padding:13px 14px;display:flex;flex-direction:column;gap:2px}
summary::-webkit-details-marker{display:none}
.st{font-weight:600;font-size:16px;display:flex;justify-content:space-between}
.st::after{content:"▾";color:var(--muted);font-size:14px}
details[open] .st::after{content:"▴"}
.sum{color:var(--muted);font-size:13px}
.body{padding:0 14px 12px;border-top:1px solid var(--line)}
.body .hint{margin-top:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0 4px}
.cell{display:flex;justify-content:space-between;align-items:center;gap:6px;border:1px solid var(--line);border-radius:10px;padding:6px 8px}
.cell input{width:64px}
small{color:var(--muted)}
.btable{margin-top:8px}.bh,.br{display:grid;grid-template-columns:1fr 56px 76px;align-items:center;padding:7px 0}
.bh{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:4px 0}
.br{border-top:1px solid var(--line)}.bh span:not(:first-child),.br .tog{justify-self:center}
.tog{display:inline-flex;align-items:center;gap:8px}
.chips{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
.chips.small{grid-template-columns:repeat(2,1fr);margin:8px 0 0}
.chip input,.tog input{flex-shrink:0}.chip{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:8px;font-size:14px}
.propgrp{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}.propgrp>.tog{font-weight:600}
.savebar{position:sticky;bottom:0;padding:10px 0 max(10px,env(safe-area-inset-bottom));background:var(--bg);display:flex;gap:10px;align-items:center}
.savebar button{flex:1;font-size:16px;padding:12px}
.reset{margin-top:14px;text-align:center}.reset button{background:none;color:var(--muted);text-decoration:underline;font-weight:400;padding:4px}
</style></head><body><main>
<header><h1>Settings</h1><div class="actions"><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<div class="status">Tap a section to change it. Applies from the next scan.</div>
${saved ? `<div class="notice">Saved.</div>` : ""}
<form method="post" action="/settings?token=${t}">
${alerts}
${books}
${sports}
${schedule}
<div class="savebar"><button type="submit">Save</button></div>
</form>
${custom ? `<form class="reset" method="post" action="/settings?token=${t}&reset=1" onsubmit="return confirm('Go back to the Netlify environment variable values?')">
<button type="submit">Reset to Netlify values</button></form>` : ""}
</main></body></html>`;
}

const prob = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/**
 * /check page. `then` = values from the alert (query params); `result` = recheck() output, or null with `error`.
 */
export function renderCheck({ then, result, error = null, token = "", now = Date.now(), minEv = 0.03, book = "", pick = "", game = "", start = null, shortcutBooks = new Set(), flags = [] }) {
  const t = encodeURIComponent(token);
  const age = then.at ? ago(now - then.at) : "";
  const h = result?.status === "ok" ? result.hit : null;
  let verdict, cls;
  if (error) [verdict, cls] = [`Couldn't re-check: ${esc(error)}`, "bad"];
  else if (result?.status === "started") [verdict, cls] = ["Game has started", "bad"];
  else if (result?.status === "nopin") [verdict, cls] = ["Pinnacle isn't offering this market now — no fair price", "bad"];
  else if (!h) [verdict, cls] = [`${esc(book)} no longer offers this line (or its number is now worse than Pinnacle's)`, "bad"];
  else if (h.ev >= minEv) [verdict, cls] = [`Still +EV · ${h.betterLine ? "≥" : ""}+${(h.ev * 100).toFixed(1)}%<div class="stake">Grade ${gradeFor(h)} · stake $${stakeFor(h)}</div>${needsVerify(h) ? `<div class="vfy">VERIFY: stale Pinnacle / injury?</div>` : ""}`, "good"];
  else if (h.ev >= 0) [verdict, cls] = [`Thin · +${(h.ev * 100).toFixed(1)}% (below your ${(minEv * 100).toFixed(1)}%)<div class="stake">Skip, or at most $5</div>`, "warn"];
  else [verdict, cls] = [`Gone · ${(h.ev * 100).toFixed(1)}% EV — don't bet`, "bad"];

  const why = [];
  if (h) {
    if (then.point != null && h.point !== then.point) why.push(`${esc(book)} moved its number: ${then.point} → ${h.point}`);
    if (h.odds !== then.odds) why.push(`${esc(book)} price moved: ${signed(then.odds)} → ${signed(h.odds)}`);
    const dp = prob(h.fair) - prob(then.fair);
    if (Math.abs(dp) >= 0.005) why.push(`Pinnacle moved ${dp > 0 ? "toward" : "against"} this side: fair ${signed(then.fair)} → ${signed(h.fair)}`);
    if (!why.length) why.push("Nothing meaningful moved since the alert.");
    if (h.pinUpdated) why.push(`Pinnacle's price last changed ${ago(now - Date.parse(h.pinUpdated))}.`);
  }

  const row = (label, a, b) => `<div class="row"><span>${label}</span><span class="cmp"><span class="then">${a}</span><span class="now">${b}</span></span></div>`;
  const evTxt = (e) => (e == null ? "—" : `${(e * 100).toFixed(1)}%`);
  const label = h?.pick || pick;
  const openHref = openLink(then.bookKey, h?.link, shortcutBooks);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a2e1a">
<title>Check price</title>
<style>${CSS}
.verdict{border-radius:12px;padding:14px;font-size:18px;font-weight:700;margin:10px 0 12px;border:1px solid var(--line);background:var(--card)}
${FLAG_CSS}
.flags{margin:-4px 0 12px}.flags .flag{font-size:15px;margin-top:6px}
.verdict .stake{font-size:16px;color:var(--text);margin-top:4px}.verdict .vfy{font-size:14px;color:var(--hot);margin-top:4px}
.verdict.good{color:var(--good)}.verdict.bad{color:var(--hot)}.verdict.warn{color:#b26a00}
@media (prefers-color-scheme:dark){.verdict.warn{color:#f0b354}}
.cmp{display:flex;gap:14px;font-variant-numeric:tabular-nums}.then{color:var(--muted);min-width:64px;text-align:right}.now{font-weight:600;min-width:64px;text-align:right}
.why{margin:0;padding-left:18px;color:var(--text)}.why li{background:none;border:0;padding:2px 0;border-radius:0}
a.open.big{display:block;text-align:center;font-size:17px;padding:12px;margin-top:10px}
</style></head><body><main>
<header><h1>Check price</h1><div class="actions"><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<div class="status">${SPORTS[then.sportKey] ? `<b>${esc(SPORTS[then.sportKey])}</b> · ` : ""}${esc(label)} @ ${esc(book)}${game ? ` · ${esc(game)}` : ""}${start ? ` · ${et(start, { weekday: "short", hour: "numeric", minute: "2-digit" })} ET` : ""}</div>
<div class="verdict ${cls}">${verdict}</div>
${flags.length ? `<div class="flags">${flagHtml(flags)}</div>` : ""}
<fieldset><legend>Alert ${age ? `(${age})` : ""} → now</legend>
${row(`${esc(book)} price`, then.odds != null ? signed(then.odds) : "—", h ? signed(h.odds) : "—")}
${then.point != null || h?.point != null ? row("Line", then.point ?? "—", h?.point ?? "—") : ""}
${row("Fair (no-vig Pin)", then.fair != null ? signed(then.fair) : "—", h ? signed(h.fair) : "—")}
${row("Pinnacle price", then.pinPrice != null ? signed(then.pinPrice) : "—", h ? signed(h.pinPrice) : "—")}
${row("EV", evTxt(then.ev), h ? evTxt(h.ev) : "—")}
${row("Grade · stake", then.ev != null && then.odds != null ? `${gradeFor(then)} · $${stakeFor(then)}` : "—", h && h.ev >= minEv ? `${gradeFor(h)} · $${stakeFor(h)}` : h ? "skip" : "—")}
</fieldset>
${why.length ? `<fieldset><legend>What changed</legend><ul class="why">${why.map((w) => `<li>${w}</li>`).join("")}</ul></fieldset>` : ""}
${openHref ? `<a class="open big ${cls === "good" ? "" : "alt"}" href="${esc(openHref)}" target="_blank" rel="noopener">Open ${esc(book)}</a>` : ""}
<a class="open alt big" href="" onclick="location.reload();return false">Re-check (1 credit)</a>
</main></body></html>`;
}
