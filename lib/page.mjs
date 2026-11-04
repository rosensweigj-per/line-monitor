// HTML for the /edges page. Pure function so it can be tested without Netlify.
import { stakeFor } from "./scan.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);
const et = (t, opts) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", ...opts });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};

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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open edges</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#15181d;--muted:#5d6570;--line:#e3e6ea;--good:#0a7a3f;--hot:#b3261e;--btn:#15181d;--btntext:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaed;--muted:#9aa2ad;--line:#2a2f37;--good:#4cc38a;--hot:#ff7b72;--btn:#e8eaed;--btntext:#0f1115}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0}
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
</style></head><body><main>
<header><h1>Open edges</h1>
<form method="post" action="/edges?token=${encodeURIComponent(token)}" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Scanning…'">
<button type="submit">Scan now</button></form></header>
<div class="status">${status}</div>
${errors.length ? `<div class="err">${errors.join("<br>")}</div>` : ""}
${notice}
${rows.length ? `<ul>${cards.join("\n")}</ul>` : `<p class="empty">No open edges right now.</p>`}
</main></body></html>`;
}
