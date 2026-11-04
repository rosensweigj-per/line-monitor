// HTML for the /edges page. Pure function so it can be tested without Netlify.
import { BOOKS, PROP_CATALOG, SPORTS, stakeFor } from "./scan.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);
const et = (t, opts) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", ...opts });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5d6570;--line:#e3e6ea;--good:#0a7a3f;--hot:#b3261e;--btn:#15181d;--btntext:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaed;--muted:#9aa2ad;--line:#2a2f37;--good:#4cc38a;--hot:#ff7b72;--btn:#e8eaed;--btntext:#0f1115}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}h1{font-size:20px;margin:4px 0}
.status{color:var(--muted);font-size:13px;margin-bottom:14px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.top{display:flex;justify-content:space-between;gap:12px;font-size:16px}.pick{font-weight:500}
.ev{color:var(--good);font-weight:700;white-space:nowrap}li.hot .ev{color:var(--hot)}
.mid{margin-top:4px}.sub{margin-top:2px;color:var(--muted);font-size:13px}
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

export function renderEdges({ edges, state, lastRun, now = Date.now(), token = "", scanned = false }) {
  const sports = Object.values(edges || {});
  const rows = sports
    .flatMap((s) => s.hits.map((h) => ({ ...h, pulledAt: s.at })))
    .filter((h) => Date.parse(h.start) > now)
    .sort((a, b) => b.ev - a.ev);

  const cards = rows.map((h) => {
    const pin = h.betterLine
      ? `Pin ${h.market === "spreads" && h.pinPoint > 0 ? "+" : ""}${h.pinPoint} ${fmt(h.pinPrice)} · better number`
      : `Pin ${fmt(h.pinPrice)}`;
    return `<li class="${h.ev >= 0.05 ? "hot" : ""}">
  <div class="top"><span class="pick">${esc(h.pick)} <b>${fmt(h.odds)}</b></span><span class="ev">${h.betterLine ? "≥" : ""}+${(h.ev * 100).toFixed(1)}%</span></div>
  <div class="mid">${esc(h.book)} · fair ${fmt(h.fair)} · ${esc(pin)} · ~$${stakeFor(h)}</div>
  <div class="sub">${esc(h.sport)} · ${esc(h.game)} · ${et(h.start, { weekday: "short", hour: "numeric", minute: "2-digit" })} ET · seen ${ago(now - h.pulledAt)}</div>
</li>`;
  });

  const status = [
    lastRun?.at ? `Last run ${ago(now - Date.parse(lastRun.at))}${lastRun.skipped ? ` (${esc(lastRun.skipped)})` : ""}` : "No runs yet",
    state?.remaining != null ? `${state.remaining} Odds API credits` : "",
  ].filter(Boolean).join(" · ");

  // Problems from the last run (API errors), so a manual scan shows what went wrong.
  const errors = Object.entries({ ...(lastRun?.sports || {}), ...(lastRun?.props || {}) })
    .filter(([, v]) => /^error/.test(v))
    .map(([k, v]) => `${esc(k)}: ${esc(v)}`);
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
<a class="btn2" href="/settings?token=${encodeURIComponent(token)}">Settings</a>
<form method="post" action="/edges?token=${encodeURIComponent(token)}" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Scanning…'">
<button type="submit">Scan now</button></form></div></header>
<div class="status">${status}</div>
${errors.length ? `<div class="err">${errors.join("<br>")}</div>` : ""}
${notice}
${rows.length ? `<ul>${cards.join("\n")}</ul>` : `<p class="empty">No open edges right now.</p>`}
</main></body></html>`;
}

const HOURS = Array.from({ length: 25 }, (_, h) => [h, h === 0 || h === 24 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`]);
const chk = (name, label, on) =>
  `<label class="chk"><input type="checkbox" name="${name}"${on ? " checked" : ""}> ${esc(label)}</label>`;

/** Settings form. `cur` comes from currentSettings(); `custom` = settings have been saved from this page. */
export function renderSettings({ cur, token = "", saved = false, custom = false }) {
  const t = encodeURIComponent(token);
  const hourSel = (name, val, lo, hi) =>
    `<select name="${name}">${HOURS.filter(([h]) => h >= lo && h <= hi)
      .map(([h, l]) => `<option value="${h}"${h === val ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Edges"><meta name="theme-color" content="#0a2e1a">
<title>Line alert settings</title>
<style>${CSS}</style></head><body><main>
<header><h1>Settings</h1><div class="actions"><a class="btn2" href="/edges?token=${t}">Edges</a></div></header>
<div class="status">Changes apply from the next scan. No redeploy needed.</div>
${saved ? `<div class="notice">Saved.</div>` : ""}
<form method="post" action="/settings?token=${t}">
<fieldset><legend>Books</legend><div class="hint">Unchecked books are ignored. The next-best book takes the alert.</div>
${Object.entries(BOOKS).map(([k, l]) => chk(`book_${k}`, l, !cur.booksOff.has(k))).join("\n")}
</fieldset>
<fieldset><legend>Sports</legend>
${Object.entries(SPORTS).map(([k, l]) => chk(`sport_${k}`, l, cur.sports.has(k))).join("\n")}
</fieldset>
${Object.entries(PROP_CATALOG).map(([sp, markets]) => `<fieldset><legend>${SPORTS[sp]} player props</legend>
<div class="hint">About 1 credit per game per hourly check, for each prop type.</div>
${chk(`props_${sp}`, `Scan ${SPORTS[sp]} props`, cur.propSports.has(sp))}
${Object.entries(markets).map(([k, [, name]]) => chk(`prop_${k}`, name, cur.propMarkets.has(k))).join("\n")}
</fieldset>`).join("\n")}
<fieldset><legend>Alert when EV is at least</legend>
<div class="row"><span>Main lines</span><span><input type="number" name="min_ev" step="0.5" min="0" max="50" value="${+(cur.minEv * 100).toFixed(2)}"> %</span></div>
<div class="row"><span>Props</span><span><input type="number" name="prop_min_ev" step="0.5" min="0" max="50" value="${+(cur.propMinEv * 100).toFixed(2)}"> %</span></div>
</fieldset>
<fieldset><legend>Hours (ET)</legend>
<div class="row"><span>Start scanning</span>${hourSel("start", cur.start, 0, 23)}</div>
<div class="row"><span>Stop scanning</span>${hourSel("end", cur.end, 1, 24)}</div>
</fieldset>
<div class="save"><button type="submit">Save</button></div>
</form>
${custom ? `<form method="post" action="/settings?token=${t}&reset=1" style="margin-top:16px" onsubmit="return confirm('Go back to the Netlify environment variable values?')">
<button class="btn2" type="submit">Reset to Netlify values</button></form>` : ""}
</main></body></html>`;
}
