// "Already bet" flags from the Bet Tracker Google Sheet, tab "Pending" (a live view of open bets on the
// Bets tab; settled bets drop off automatically; A2 reads "none" when there are none). READ-ONLY by design:
// the only Google calls are an OAuth token request with the spreadsheets.readonly scope and a
// values GET. Nothing in this file (or anywhere in the monitor) writes to the sheet.
import { createSign } from "node:crypto";
import { BOOKS, PROP_LABELS } from "./scan.mjs";

export const DEFAULT_SHEET_ID = "1-B7rhvOf9bto3u-P_cgtyBJ2I87n13i9bbtxvANyWrY";
export const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const CACHE_MS = 2 * 60e3;

/** The sheet's gameKey for a monitor hit: oddsApiEventId|market|side|point (point blank for moneylines). */
export function gameKeyFor(h) {
  const side = h.player ? `${h.player} ${h.side}` : h.side;
  const point = h.market === "h2h" || h.point == null ? "" : String(h.point);
  return [h.eventId, h.market, side, point].join("|");
}

function parseKey(k) {
  const [eventId, market, side, point] = String(k || "").split("|");
  if (!eventId || !market || !side) return null;
  const m = side.match(/^(.*) (Over|Under)$/);
  const isProp = market.startsWith("player_");
  return {
    eventId, market, side,
    // for props the "side" is "Player Over|Under": split so the opposite side is the same player's other half
    player: isProp && m ? m[1] : "",
    ou: m ? m[2] : "",
    point: point === "" || point == null ? null : Number(point),
  };
}

/** "theScore Bet", "DraftKings", "Hard Rock Bet" ... -> monitor book key (or "" if unknown). */
export function bookKeyFromName(name) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(name);
  for (const variant of [n, n.replace(/(sportsbook|bet)$/, ""), n.replace(/sportsbook$/, "")]) {
    for (const [k, label] of Object.entries(BOOKS)) if (variant && (norm(k) === variant || norm(label) === variant)) return k;
  }
  return "";
}

/** Sheet values (rows of strings, header first) -> open (pending) bets that carry a gameKey. Columns found by header name. */
export function parseOpenBets(values) {
  if (!values?.length) return [];
  const head = values[0].map((h) => String(h).trim());
  const col = (name) => head.indexOf(name);
  const c = {
    id: col("id"), book: col("book"), odds: col("odds"), stake: col("stake"), status: col("status"),
    gameKey: col("gameKey"), funding: col("funding"), sheetRow: col("sheetRow"),
  };
  if (c.gameKey < 0) return [];
  const out = [];
  for (const r of values.slice(1)) {
    // Open = pending or blank (the Pending tab only lists those; settled statuses are skipped defensively).
    const status = c.status < 0 ? "" : String(r[c.status] || "").trim().toLowerCase();
    if (status && status !== "pending") continue;
    const key = parseKey(r[c.gameKey]);
    if (!key) continue;
    out.push({
      ...key,
      id: r[c.id] || "",
      book: r[c.book] || "",
      bookKey: bookKeyFromName(r[c.book]),
      odds: Number(r[c.odds]),
      stake: Number(String(r[c.stake] ?? "").replace(/[$,]/g, "")) || 0,
      bonus: c.funding >= 0 && String(r[c.funding] || "").trim().toLowerCase() === "bonus",
      sheetRow: c.sheetRow >= 0 ? r[c.sheetRow] || "" : "",
    });
  }
  return out;
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const stakeTxt = (b) => `${money(b.stake)}${b.bonus ? " bonus" : ""}`;
function describe(b) {
  const label = PROP_LABELS[b.market] ? ` ${PROP_LABELS[b.market]}` : "";
  const what = b.market === "h2h" ? `${b.side} ML` : b.point != null ? `${b.side} ${b.market === "spreads" ? signed(b.point) : b.point}${label}` : b.side;
  return `${what}${Number.isFinite(b.odds) ? ` ${signed(b.odds)}` : ""}`;
}

/** Would this hit plus the opposite bet `b` leave a window where both win? */
export function isMiddle(h, b) {
  if (h.market === "h2h" || h.point == null || b.point == null) return false;
  if (h.market === "spreads") return h.point + b.point > 0; // e.g. +3.5 here, other side -2.5 -> lands on 3 wins both
  const over = h.side === "Over" ? h.point : b.point;
  const under = h.side === "Over" ? b.point : h.point;
  return over < under; // Over 219.5 + Under 221.5 -> 220 or 221 wins both
}

/**
 * Flags for one hit against open bets. Never suppresses anything; returns [{ level, text }], most serious first.
 * levels: "conflict" (other side at the SAME book), "opposite", "same", "event" (same game, other market/player).
 */
export function betFlags(h, open) {
  if (!open?.length || !h?.eventId) return [];
  const mySide = h.player ? `${h.player} ${h.side}` : h.side;
  const sameGame = open.filter((b) => b.eventId === h.eventId);
  if (!sameGame.length) return [];
  const sameMarket = sameGame.filter((b) => b.market === h.market && (!h.player || b.player === h.player));
  const same = sameMarket.filter((b) => b.side === mySide);
  const opp = sameMarket.filter((b) => b.side !== mySide);
  const other = sameGame.filter((b) => !sameMarket.includes(b));
  const flags = [];

  const conflict = opp.filter((b) => b.bookKey && b.bookKey === h.bookKey);
  if (conflict.length) {
    flags.push({ level: "conflict", text: `⛔ Other side already at ${h.book}: ${conflict.map((b) => `${describe(b)} ${stakeTxt(b)}`).join(", ")} — never opposite sides at one book` });
  }
  const oppElsewhere = opp.filter((b) => !conflict.includes(b));
  if (oppElsewhere.length) {
    const middle = oppElsewhere.some((b) => isMiddle(h, b));
    flags.push({ level: "opposite", text: `⚠ You have the other side (${oppElsewhere.map((b) => `${b.book} ${describe(b)} ${stakeTxt(b)}`).join(", ")}) — possible ${middle ? "middle/hedge" : "hedge"}` });
  }
  if (same.length) {
    const cash = same.filter((b) => !b.bonus).reduce((s, b) => s + b.stake, 0);
    const bonus = same.filter((b) => b.bonus).reduce((s, b) => s + b.stake, 0);
    const amt = [cash ? money(cash) : "", bonus ? `${money(bonus)} bonus` : ""].filter(Boolean).join(" + ");
    flags.push({ level: "same", text: `✓ You have ${amt} on this (${same.map((b) => `${b.book} ${describe(b).replace(/^.* (?=[+-]\d+$)/, "")}${b.point != null && b.point !== h.point ? ` at ${b.market === "spreads" ? signed(b.point) : b.point}` : ""}`).join(", ")})` });
  }
  if (other.length) {
    flags.push({ level: "event", text: `ℹ Also on this game: ${other.map((b) => `${describe(b)} (${b.book})`).join(", ")}` });
  }
  return flags;
}

// ---------- Google Sheets (read-only) ----------

/** Service-account credentials from env: GOOGLE_SA_EMAIL + GOOGLE_SA_KEY, or GOOGLE_SERVICE_ACCOUNT_JSON. */
export function sheetCreds(env) {
  let email = env("GOOGLE_SA_EMAIL"), key = env("GOOGLE_SA_KEY");
  const json = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if ((!email || !key) && json) {
    try { const j = JSON.parse(json); email ||= j.client_email; key ||= j.private_key; } catch { /* ignore */ }
  }
  if (!email || !key) return null;
  return {
    email,
    key: key.replace(/\\n/g, "\n"),
    sheetId: env("BET_TRACKER_SHEET_ID") || DEFAULT_SHEET_ID,
    tab: env("BET_TRACKER_TAB") || "Pending",
  };
}

const b64url = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken({ email, key }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: email, scope: READONLY_SCOPE, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google auth HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).access_token;
}

/** Read the Pending tab, columns A:T (values only, GET). */
export async function fetchSheetValues(creds, now = Date.now()) {
  const token = await accessToken(creds, now);
  const range = encodeURIComponent(`${creds.tab}!A:T`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${creds.sheetId}/values/${range}?majorDimension=ROWS`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).values || [];
}

// ---------- Published CSV (File → Share → Publish to web → Pending tab → CSV) ----------

/** Minimal RFC 4180 CSV parser: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** GET the published CSV. Read-only by nature: a published link can't change the sheet. */
export async function fetchCsvValues(url) {
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)) throw new Error("BET_TRACKER_CSV_URL must be a docs.google.com/spreadsheets link");
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("CSV link returned a web page — publish the Pending tab as CSV (File → Share → Publish to web)");
  return parseCsv(text.replace(/^\uFEFF/, ""));
}

/**
 * Open bets, cached in the monitor's own blob store for 2 minutes. Returns { open, error }.
 * No credentials -> { open: [] } (feature off). Errors never throw: alerts must not depend on the sheet.
 */
export async function loadOpenBets(store, env, now = Date.now()) {
  const csvUrl = env("BET_TRACKER_CSV_URL");
  const creds = csvUrl ? null : sheetCreds(env);
  if (!csvUrl && !creds) return { open: [], off: true };
  try {
    const cached = await store.get("betsCache", { type: "json" });
    if (cached && now - cached.at < CACHE_MS) return { open: cached.open };
    const values = csvUrl ? await fetchCsvValues(csvUrl) : await fetchSheetValues(creds, now);
    const open = parseOpenBets(values);
    await store.setJSON("betsCache", { at: now, open });
    return { open };
  } catch (e) {
    return { open: [], error: e.message };
  }
}
