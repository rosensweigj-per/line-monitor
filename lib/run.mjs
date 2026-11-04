// One monitor run. `store` is a Netlify Blobs store (get/setJSON); `env` is a getter for env vars.
import { BOOKMAKERS, findEdges, formatHit, SPORTS } from "./scan.mjs";

const API = "https://api.the-odds-api.com/v4/sports";

export async function runMonitor({ store, env, force = false, now = Date.now(), log = console.log }) {
  const key = env("ODDS_API_KEY");
  const sports = (env("SPORTS") || "americanfootball_nfl,americanfootball_ncaaf,basketball_nba,basketball_ncaab,icehockey_nhl")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const minEv = Number(env("MIN_EV") || 0.03);
  const minRemaining = Number(env("MIN_REMAINING") || 3000);
  const nearMin = Number(env("NEAR_INTERVAL_MIN") || 15); // game within 4h
  const farMin = Number(env("FAR_INTERVAL_MIN") || 60);   // next game further out
  const activeStart = Number(env("ACTIVE_START_HOUR_ET") || 9);
  const activeEnd = Number(env("ACTIVE_END_HOUR_ET") || 24);

  const state = (await store.get("state", { type: "json" })) || { lastPull: {}, alerted: {}, remaining: null, lowWarned: false };
  const summary = { at: new Date(now).toISOString(), sports: {}, newHits: [], remaining: state.remaining };

  // Quiet hours (ET)
  const hourET = Number(new Date(now).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }));
  if (!force && (hourET < activeStart || hourET >= activeEnd)) {
    summary.skipped = `quiet hours (${hourET}:00 ET)`;
    await store.setJSON("lastRun", summary);
    return summary;
  }

  // Credit guard
  if (state.remaining != null && state.remaining < minRemaining) {
    summary.skipped = `credits low (${state.remaining} < ${minRemaining})`;
    if (!state.lowWarned && canPush(env)) {
      await push(env, "Line alerts paused", `Odds API credits at ${state.remaining}. Monitor paused below ${minRemaining} so your Claude tasks keep working.`);
      state.lowWarned = true;
      await store.setJSON("state", state);
    }
    await store.setJSON("lastRun", summary);
    return summary;
  }

  const allHits = [];
  for (const sport of sports) {
    try {
      // Free call (0 credits): upcoming events, to decide whether this sport is due.
      const ev = await getJSON(`${API}/${sport}/events?apiKey=${key}`);
      const upcoming = ev.json.map((e) => Date.parse(e.commence_time)).filter((t) => t > now && t < now + 36 * 3600e3);
      if (!upcoming.length) { summary.sports[sport] = "no games in 36h"; continue; }
      const nextStart = Math.min(...upcoming);
      const interval = nextStart - now < 4 * 3600e3 ? nearMin : farMin;
      const last = state.lastPull[sport] || 0;
      if (!force && now - last < (interval - 1) * 60e3) {
        summary.sports[sport] = `not due (every ${interval}m)`;
        continue;
      }

      const from = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
      const to = new Date(now + 36 * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
      const r = await getJSON(
        `${API}/${sport}/odds?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american` +
        `&bookmakers=${BOOKMAKERS}&commenceTimeFrom=${from}&commenceTimeTo=${to}`
      );
      state.lastPull[sport] = now;
      const rem = Number(r.headers.get("x-requests-remaining"));
      if (!Number.isNaN(rem)) { state.remaining = rem; summary.remaining = rem; if (rem >= minRemaining) state.lowWarned = false; }
      const hits = findEdges(r.json, sport, { minEv, now });
      summary.sports[sport] = `pulled ${r.json.length} games, ${hits.length} edges`;
      allHits.push(...hits);
    } catch (e) {
      summary.sports[sport] = `error: ${e.message}`;
      log(`[${sport}] ${e.message}`);
    }
  }

  // Dedupe: alert new edges, or ones whose price improved, or re-alert after 6h.
  for (const [k, a] of Object.entries(state.alerted)) if (Date.parse(a.start) < now) delete state.alerted[k];
  const fresh = allHits.filter((h) => {
    const prev = state.alerted[h.key];
    return !prev || h.odds > prev.odds || now - prev.at > 6 * 3600e3;
  });
  for (const h of allHits) {
    const prev = state.alerted[h.key];
    if (!prev || fresh.includes(h)) state.alerted[h.key] = { odds: h.odds, at: now, start: h.start };
  }

  summary.newHits = fresh.map((h) => ({ ...h, ev: +(h.ev * 100).toFixed(1) }));
  summary.openEdges = allHits.length;

  if (fresh.length && canPush(env)) {
    const maxEv = Math.max(...fresh.map((h) => h.ev));
    const title = `+EV: ${fresh.length} line${fresh.length > 1 ? "s" : ""} (best +${(maxEv * 100).toFixed(1)}%)`;
    const footer = summary.remaining != null ? `\n\nOdds API credits: ${summary.remaining}` : "";
    // Pushover caps messages at 1024 chars: include as many hits (best first) as fit.
    let body = "";
    let shown = 0;
    for (const h of fresh) {
      const more = fresh.length - shown - 1;
      const next = (body ? body + "\n\n" : "") + formatHit(h);
      const tail = (more ? `\n\n+${more} more` : "") + footer;
      if (shown && next.length + tail.length > 1000) break;
      body = next;
      shown++;
    }
    if (shown < fresh.length) body += `\n\n+${fresh.length - shown} more`;
    body += footer;
    await push(env, title, body, maxEv >= 0.05);
  }

  await store.setJSON("state", state);
  await store.setJSON("lastRun", summary);
  return summary;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return { json: await res.json(), headers: res.headers };
}

export const canPush = (env) => !!((env("PUSHOVER_TOKEN") && env("PUSHOVER_USER")) || env("NTFY_TOPIC"));

// Sends to Pushover when PUSHOVER_TOKEN + PUSHOVER_USER are set, and to ntfy when NTFY_TOPIC is set.
// high = true sends Pushover priority 1 (bypasses your Pushover quiet hours) / ntfy priority 4.
export async function push(env, title, body, high = false) {
  const sent = [];
  const token = env("PUSHOVER_TOKEN");
  const user = env("PUSHOVER_USER");
  if (token && user) {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      body: new URLSearchParams({
        token,
        user,
        title: title.slice(0, 250),
        message: body.slice(0, 1024),
        priority: high ? "1" : "0",
        ...(env("PUSHOVER_SOUND") ? { sound: env("PUSHOVER_SOUND") } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Pushover HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    sent.push("pushover");
  }
  const topic = env("NTFY_TOPIC");
  if (topic) {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body,
      headers: { Title: title, Priority: high ? "4" : "3", Tags: "moneybag" },
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
    sent.push("ntfy");
  }
  if (!sent.length) throw new Error("no push channel configured (set PUSHOVER_TOKEN + PUSHOVER_USER)");
  return sent;
}
