// Settings saved from the /settings page (Netlify Blobs key "settings"). They use the same names as the
// env vars and win over them, so the page works without editing Netlify or redeploying.
import { BOOKS, PROP_CATALOG, PROP_DEFAULTS, SPORTS, resolveBooks } from "./scan.mjs";

export const DEFAULT_SPORTS = "americanfootball_nfl,americanfootball_ncaaf,basketball_nba,basketball_ncaab,icehockey_nhl";

export async function loadSettings(store) {
  return (await store.get("settings", { type: "json" })) || {};
}

/** env getter where saved settings override Netlify env vars. */
export const withSettings = (env, saved) => (k) => (saved && k in saved ? saved[k] : env(k));

const list = (v) => (/^(off|none)$/i.test(String(v ?? "").trim()) ? [] : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const num = (v, def) => (v == null || v === "" || Number.isNaN(Number(v)) ? def : Number(v));

/** Current effective values, for pre-filling the form. */
export function currentSettings(env) {
  return {
    booksOff: resolveBooks(env("BOOKS_OFF") || ""),
    shortcutBooks: resolveBooks(env("BOOK_SHORTCUTS") || ""),
    sports: new Set(list(env("SPORTS") || DEFAULT_SPORTS)),
    propSports: new Set(list(env("PROP_SPORTS") ?? "basketball_nba")),
    propMarkets: new Set(list(env("PROP_MARKETS") || "player_points")),
    minEv: num(env("MIN_EV"), 0.03),
    propMinEv: num(env("PROP_MIN_EV"), 0.04),
    start: num(env("ACTIVE_START_HOUR_ET"), 9),
    end: num(env("ACTIVE_END_HOUR_ET"), 22),
    ttl: num(env("ALERT_TTL_MIN"), 10),
  };
}

/** Form submission (URLSearchParams / FormData) -> settings object to save. */
export function parseSettingsForm(form) {
  const clamp = (v, lo, hi, def) => Math.min(hi, Math.max(lo, num(v, def)));
  const pct = (v, def) => +(clamp(v, 0, 50, def * 100) / 100).toFixed(4);
  const off = Object.keys(BOOKS).filter((k) => !form.has(`book_${k}`));
  const sports = Object.keys(SPORTS).filter((k) => form.has(`sport_${k}`));
  const propSports = Object.keys(PROP_CATALOG).filter((sp) => form.has(`props_${sp}`));
  const markets = [];
  for (const [sp, mk] of Object.entries(PROP_CATALOG)) {
    const picked = Object.keys(mk).filter((k) => form.has(`prop_${k}`));
    markets.push(...(picked.length || !propSports.includes(sp) ? picked : PROP_DEFAULTS[sp]));
  }
  let start = clamp(form.get("start"), 0, 23, 9);
  let end = clamp(form.get("end"), 1, 24, 22);
  if (end <= start) end = Math.min(24, start + 1);
  return {
    BOOKS_OFF: off.join(","),
    BOOK_SHORTCUTS: Object.keys(BOOKS).filter((k) => form.has(`sc_${k}`)).join(","),
    SPORTS: sports.length ? sports.join(",") : "off",
    PROP_SPORTS: propSports.length ? propSports.join(",") : "off",
    PROP_MARKETS: (markets.length ? markets : PROP_DEFAULTS.basketball_nba).join(","),
    MIN_EV: String(pct(form.get("min_ev"), 0.03)),
    PROP_MIN_EV: String(pct(form.get("prop_min_ev"), 0.04)),
    ACTIVE_START_HOUR_ET: String(start),
    ACTIVE_END_HOUR_ET: String(end),
    ALERT_TTL_MIN: String(Math.round(clamp(form.get("ttl"), 0, 240, 10))),
  };
}
