// Team notes from the Bet Tracker's "Notes" tab (published as CSV). READ-ONLY: shown on alerts, edge cards and the
// check page; never changes EV, stake or grade. Columns by header name: team, sport, note, until (YYYY-MM-DD), added.
import { fetchCsvValues } from "./bets.mjs";
import { SPORTS } from "./scan.mjs";

const CACHE_MS = 5 * 60e3;
const nm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SPORT_LABEL = Object.fromEntries(Object.entries(SPORTS).map(([k, l]) => [k, l.toUpperCase()]));

/** Accepts the published link in either form; returns the CSV form. */
export function notesCsvUrl(url) {
  if (!url) return "";
  let u = url.trim().replace("/pubhtml", "/pub");
  if (!/[?&]output=csv/.test(u)) u += (u.includes("?") ? "&" : "?") + "output=csv";
  return u;
}

/** CSV values -> active notes [{ team, sport, note, until }] (until on or after today, ET). */
export function parseNotes(values, now = Date.now()) {
  if (!values?.length) return [];
  const head = values[0].map((h) => String(h).trim().toLowerCase());
  const c = { team: head.indexOf("team"), sport: head.indexOf("sport"), note: head.indexOf("note"), until: head.indexOf("until") };
  if (c.team < 0 || c.note < 0) return [];
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const out = [];
  for (const r of values.slice(1)) {
    const team = String(r[c.team] || "").trim(), note = String(r[c.note] || "").trim();
    if (!team || !note) continue;
    const until = c.until >= 0 ? String(r[c.until] || "").trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(until) && until < today) continue;
    out.push({ team, sport: c.sport >= 0 ? String(r[c.sport] || "").trim().toUpperCase() : "", note, until });
  }
  return out;
}

/** Notes for either team in a hit's game, same sport. Works for main lines and props (uses "Away @ Home"). */
export function notesFor(h, notes) {
  if (!notes?.length || !h) return [];
  const teams = String(h.game || "").split(" @ ").map(nm).filter(Boolean);
  if (h.side && !h.player) teams.push(nm(h.side));
  if (h.opp) teams.push(nm(h.opp));
  const label = SPORT_LABEL[h.sportKey] || String(h.sport || "").toUpperCase();
  const seen = new Set();
  return notes.filter((n) => {
    if (n.sport && label && n.sport !== label) return false;
    const key = `${n.team}|${n.note}`;
    if (seen.has(key) || !teams.includes(nm(n.team))) return false;
    seen.add(key);
    return true;
  });
}

/** "📝 Duke Blue Devils: One-dimensional offense…" (one line per note, trimmed). */
export const noteLines = (h, notes) => notesFor(h, notes).map((n) => `📝 ${n.team}: ${n.note.length > 140 ? n.note.slice(0, 137) + "…" : n.note}`);

/** Active notes, cached 5 min in blob "notesCache". No URL -> []; errors never throw. */
export async function loadNotes(store, env, now = Date.now()) {
  const url = notesCsvUrl(env("BET_TRACKER_NOTES_URL"));
  if (!url) return { notes: [], off: true };
  try {
    const cached = await store.get("notesCache", { type: "json" });
    if (cached && cached.url === url && now - cached.at < CACHE_MS) return { notes: parseNotes(cached.values, now) };
    const values = await fetchCsvValues(url);
    await store.setJSON("notesCache", { at: now, url, values });
    return { notes: parseNotes(values, now) };
  } catch (e) {
    return { notes: [], error: e.message };
  }
}
