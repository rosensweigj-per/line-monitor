// One monitor run. `store` is a Netlify Blobs store (get/setJSON); `env` is a getter for env vars.
// Settings saved from the /settings page override env vars of the same name.
import { BOOKMAKERS, checkUrl, findEdges, findPropEdges, formatHit, gradeFor, openLink, propMarketsFor, resolveBooks, SPORTS, stakeFor } from "./scan.mjs";
import { loadSettings, minEvFor, withSettings } from "./settings.mjs";
import { betFlags, loadOpenBets } from "./bets.mjs";

const API = "https://api.the-odds-api.com/v4/sports";

export async function runMonitor({ store, env: baseEnv, force = false, now = Date.now(), log = console.log }) {
  const env = withSettings(baseEnv, await loadSettings(store));
  const key = env("ODDS_API_KEY");
  const list = (v) => (/^(off|none)$/i.test(v.trim()) ? [] : v.split(",").map((s) => s.trim()).filter(Boolean));
  const sports = list(env("SPORTS") || "americanfootball_nfl,americanfootball_ncaaf,basketball_nba,basketball_ncaab,icehockey_nhl");
  const num = (k, def) => {
    const v = env(k);
    return v == null || v === "" || Number.isNaN(Number(v)) ? def : Number(v);
  };
  const minEv = num("MIN_EV", 0.03);
  const minEvByMarket = { h2h: minEvFor(env, "h2h"), spreads: minEvFor(env, "spreads"), totals: minEvFor(env, "totals") };
  const minRemaining = num("MIN_REMAINING", 3000);
  const tipMin = num("TIP_INTERVAL_MIN", 5);    // game within 1h
  const nearMin = num("NEAR_INTERVAL_MIN", 15); // game within 4h
  const farMin = num("FAR_INTERVAL_MIN", 60);   // next game further out
  const activeStart = num("ACTIVE_START_HOUR_ET", 9);
  const activeEnd = num("ACTIVE_END_HOUR_ET", 22); // last run 9:55 PM ET
  const skipBooks = resolveBooks(env("BOOKS_OFF") || "");
  const scanOpts = { now, skipBooks, state: (env("BOOK_STATE") || "va").toLowerCase() };

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
  const edges = (await store.get("edges", { type: "json" })) || {};
  const eventsBySport = {};
  const noteRemaining = (r) => {
    const rem = Number(r.headers.get("x-requests-remaining"));
    if (!Number.isNaN(rem) && r.headers.get("x-requests-remaining") != null) {
      state.remaining = rem; summary.remaining = rem;
      if (rem >= minRemaining) state.lowWarned = false;
    }
  };
  for (const sport of sports) {
    try {
      // Free call (0 credits): upcoming events, to decide whether this sport is due.
      const ev = await getJSON(`${API}/${sport}/events?apiKey=${key}`);
      eventsBySport[sport] = ev.json;
      const upcoming = ev.json.map((e) => Date.parse(e.commence_time)).filter((t) => t > now && t < now + 36 * 3600e3);
      if (!upcoming.length) { summary.sports[sport] = "no games in 36h"; delete edges[sport]; continue; }
      const nextStart = Math.min(...upcoming);
      const interval = nextStart - now < 3600e3 ? tipMin : nextStart - now < 4 * 3600e3 ? nearMin : farMin;
      const last = state.lastPull[sport] || 0;
      if (!force && now - last < (interval - 1) * 60e3) {
        summary.sports[sport] = `not due (every ${interval}m)`;
        continue;
      }

      const from = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
      const to = new Date(now + 36 * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
      const r = await getOdds(
        `${API}/${sport}/odds?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american` +
        `&bookmakers=${BOOKMAKERS}&commenceTimeFrom=${from}&commenceTimeTo=${to}`
      );
      state.lastPull[sport] = now;
      noteRemaining(r);
      const hits = findEdges(r.json, sport, { ...scanOpts, minEv, minEvByMarket });
      summary.sports[sport] = `pulled ${r.json.length} games, ${hits.length} edges`;
      edges[sport] = { at: now, hits };
      allHits.push(...hits);
    } catch (e) {
      summary.sports[sport] = `error: ${e.message}`;
      log(`[${sport}] ${e.message}`);
    }
  }

  // Player props: one call per game (cost = prop markets returned), only for games starting soon.
  const propSports = list(env("PROP_SPORTS") ?? "basketball_nba");
  const propMarkets = list(env("PROP_MARKETS") || "player_points");
  const propMinEv = num("PROP_MIN_EV", 0.04);
  const propInterval = num("PROP_INTERVAL_MIN", 60);
  const propWindowH = num("PROP_WINDOW_HOURS", 6);
  state.lastProp ||= {};
  if (propSports.length) summary.props = {};
  for (const sport of propSports) {
    const markets = propMarketsFor(sport, propMarkets).join(",");
    if (!markets) { summary.props[sport] = "no prop markets for this sport"; continue; }
    try {
      const events = eventsBySport[sport] || (await getJSON(`${API}/${sport}/events?apiKey=${key}`)).json;
      let pulled = 0, found = 0;
      for (const e of events) {
        const t = Date.parse(e.commence_time);
        if (t <= now || t > now + propWindowH * 3600e3) continue;
        if (!force && now - (state.lastProp[e.id] || 0) < (propInterval - 1) * 60e3) continue;
        if (state.remaining != null && state.remaining < minRemaining) break;
        const r = await getOdds(
          `${API}/${sport}/events/${e.id}/odds?apiKey=${key}&regions=us&markets=${markets}` +
          `&oddsFormat=american&bookmakers=${BOOKMAKERS}`
        );
        state.lastProp[e.id] = now;
        noteRemaining(r);
        const hits = findPropEdges(r.json, sport, { ...scanOpts, minEv: propMinEv });
        edges[`props:${e.id}`] = { at: now, hits };
        allHits.push(...hits);
        pulled++; found += hits.length;
      }
      summary.props[sport] = pulled ? `pulled props for ${pulled} games, ${found} edges` : `no games due (within ${propWindowH}h, every ${propInterval}m)`;
    } catch (e) {
      summary.props[sport] = `error: ${e.message}`;
      log(`[props ${sport}] ${e.message}`);
    }
  }
  for (const [id, t] of Object.entries(state.lastProp)) if (now - t > 24 * 3600e3) delete state.lastProp[id];
  for (const [k, v] of Object.entries(edges)) if (k.startsWith("props:") && now - v.at > 12 * 3600e3) delete edges[k];

  // Dedupe: alert new edges, or ones whose price improved, or re-alert after 6h.
  for (const [k, a] of Object.entries(state.alerted)) if (Date.parse(a.start) < now) delete state.alerted[k];
  let fresh = allHits.filter((h) => {
    const prev = state.alerted[h.key];
    return !prev || h.odds > prev.odds || now - prev.at > 6 * 3600e3;
  });
  for (const h of allHits) {
    const prev = state.alerted[h.key];
    if (!prev || fresh.includes(h)) state.alerted[h.key] = { odds: h.odds, at: now, start: h.start };
  }

  if (skipBooks.size) summary.booksOff = [...skipBooks];
  summary.newHits = fresh.map((h) => ({ ...h, ev: +(h.ev * 100).toFixed(1) }));
  summary.openEdges = allHits.length;

  if (fresh.length && canPush(env)) {
    // Tag (never suppress) alerts with what's already open in the Bet Tracker sheet (read-only).
    const bets = await loadOpenBets(store, env, now);
    if (!bets.off) summary.bets = bets.error ? { error: bets.error } : { open: bets.open.length };
    fresh = fresh.map((h) => ({ ...h, flags: betFlags(h, bets.open) }));
    const ttlMin = num("ALERT_TTL_MIN", 10);
    const maxEach = Math.max(1, Math.round(num("ALERT_MAX_INDIVIDUAL", 5)));
    const opts = { ttlSec: ttlMin > 0 ? Math.round(ttlMin * 60) : 0, at: now };
    const found = new Date(now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    const footer = `\n\nFound ${found} ET${ttlMin > 0 ? ` · expires in ${ttlMin} min` : ""}` +
      (summary.remaining != null ? ` · credits ${summary.remaining}` : "");
    const base = env("SITE_URL") || env("URL");
    const token = env("RUN_TOKEN");
    const shortcuts = resolveBooks(env("BOOK_SHORTCUTS") || "");
    const evTxt = (h) => `${h.betterLine ? "≥" : ""}+${(h.ev * 100).toFixed(1)}%`;

    // One Pushover message per edge (best first), each with its own Check price link.
    for (const h of fresh.slice(0, maxEach)) {
      const check = base ? checkUrl(base, token, h, now) : null;
      const direct = openLink(h.bookKey, h.link, shortcuts);
      const link = check ? { url: check, title: `Check price, then open ${h.book}` } : direct && { url: direct, title: `Open ${h.book}` };
      const title = `${evTxt(h)} ${gradeFor(h)} · ${h.pick} ${h.odds > 0 ? "+" : ""}${h.odds} @ ${h.book}`;
      await push(env, title, formatHit(h) + footer, h.ev >= 0.05, link, opts);
    }
    // Anything beyond that goes in one summary that opens the edges page.
    const rest = fresh.slice(maxEach);
    if (rest.length) {
      let body = "";
      for (const h of rest) {
        const line = `${h.sport} · ${h.pick} ${h.odds > 0 ? "+" : ""}${h.odds} @ ${h.book} · ${evTxt(h)} · $${stakeFor(h)}`;
        if ((body + line).length > 900) { body += "\n…"; break; }
        body += (body ? "\n" : "") + line;
      }
      const edgesLink = base && token ? { url: `${base.replace(/\/$/, "")}/edges?token=${encodeURIComponent(token)}`, title: "Open edges page" } : null;
      await push(env, `+${rest.length} more edge${rest.length > 1 ? "s" : ""}`, body + footer, false, edgesLink, opts);
    }

    // Recent alerts log for the edges page (so an alert can always be found and re-checked).
    const log = ((await store.get("alerts", { type: "json" })) || []).filter((a) => Date.parse(a.start) > now);
    for (const h of fresh) log.unshift({ ...h, alertedAt: now });
    const seenKey = new Set();
    await store.setJSON("alerts", log.filter((a) => !seenKey.has(a.key) && seenKey.add(a.key)).slice(0, 60));
  }

  await store.setJSON("edges", edges);
  await store.setJSON("state", state);
  await store.setJSON("lastRun", summary);
  return summary;
}

/** One game, the given markets, fresh. Costs (markets returned) credits. */
export async function fetchEvent({ key, sport, eventId, markets }) {
  return getOdds(
    `${API}/${sport}/events/${encodeURIComponent(eventId)}/odds?apiKey=${key}&regions=us&markets=${markets}` +
    `&oddsFormat=american&bookmakers=${BOOKMAKERS}`
  );
}

// Odds pull with bookmaker deep links; if the API ever rejects includeLinks, retry without it.
async function getOdds(url) {
  try {
    return await getJSON(`${url}&includeLinks=true`);
  } catch (e) {
    if (/HTTP (400|422)/.test(e.message)) return getJSON(url);
    throw e;
  }
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return { json: await res.json(), headers: res.headers };
}

export const canPush = (env) => !!((env("PUSHOVER_TOKEN") && env("PUSHOVER_USER")) || env("NTFY_TOPIC"));

// Sends to Pushover when PUSHOVER_TOKEN + PUSHOVER_USER are set, and to ntfy when NTFY_TOPIC is set.
// high = true sends Pushover priority 1 (bypasses your Pushover quiet hours) / ntfy priority 4.
// link = { url, title } adds a tap-to-open link. ttlSec > 0 makes Pushover delete the alert after that long;
// at = when the edge was found (shown as the alert's time).
export async function push(env, title, body, high = false, link = null, { ttlSec = 0, at = null } = {}) {
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
        ...(link?.url ? { url: link.url.slice(0, 512), url_title: (link.title || "Open").slice(0, 100) } : {}),
        ...(env("PUSHOVER_SOUND") ? { sound: env("PUSHOVER_SOUND") } : {}),
        ...(ttlSec > 0 ? { ttl: String(ttlSec) } : {}),
        ...(at ? { timestamp: String(Math.floor(at / 1000)) } : {}),
      }),
    });
    if (!res.ok) {
      const hint = (v) => `${v[0]}…${v.at(-1)} (${v.length} chars${/^[A-Za-z0-9]{30}$/.test(v) ? "" : ", expected 30 letters/digits"})`;
      throw new Error(
        `Pushover HTTP ${res.status} ${(await res.text()).slice(0, 200)} | PUSHOVER_TOKEN=${hint(token)} PUSHOVER_USER=${hint(user)}` +
        (token === user ? " | token and user key are the same value" : "")
      );
    }
    sent.push("pushover");
  }
  const topic = env("NTFY_TOPIC");
  if (topic) {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body,
      headers: { Title: title, Priority: high ? "4" : "3", Tags: "moneybag", ...(link?.url ? { Click: link.url } : {}) },
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
    sent.push("ntfy");
  }
  if (!sent.length) throw new Error("no push channel configured (set PUSHOVER_TOKEN + PUSHOVER_USER)");
  return sent;
}
