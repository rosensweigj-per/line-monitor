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

/**
 * EV threshold for a market. Moneyline / spread / total each fall back to MIN_EV (3%); props use PROP_MIN_EV (4%).
 */
export function minEvFor(env, market, sport = "") {
  const bump = sportBump(env, sport);
  if (market.startsWith("player_")) return num(env("PROP_MIN_EV"), 0.04) + bump;
  const base = num(env("MIN_EV"), 0.03);
  const key = { h2h: "MIN_EV_ML", spreads: "MIN_EV_SPREAD", totals: "MIN_EV_TOTAL" }[market];
  return (key ? num(env(key), base) : base) + bump;
}
/** Extra EV required for every alert in one sport (EV_BUMP_<sport key>, e.g. 0.02 on college basketball). */
export const sportBump = (env, sport) => (sport ? Math.max(0, num(env(`EV_BUMP_${sport}`), 0)) : 0);

/** Current effective values, for pre-filling the form. */
export function currentSettings(env) {
  return {
    booksOff: resolveBooks(env("BOOKS_OFF") || ""),
    shortcutBooks: resolveBooks(env("BOOK_SHORTCUTS") || ""),
    sports: new Set(list(env("SPORTS") || DEFAULT_SPORTS)),
    propSports: new Set(list(env("PROP_SPORTS") ?? "basketball_nba")),
    propMarkets: new Set(list(env("PROP_MARKETS") || "player_points")),
    minEvMl: minEvFor(env, "h2h"),
    minEvSpread: minEvFor(env, "spreads"),
    minEvTotal: minEvFor(env, "totals"),
    propMinEv: num(env("PROP_MIN_EV"), 0.04),
    maxOdds: num(env("MAX_ODDS"), 300),
    bumps: Object.fromEntries(Object.keys(SPORTS).map((k) => [k, sportBump(env, k)])),
    start: num(env("ACTIVE_START_HOUR_ET"), 9),
    end: num(env("ACTIVE_END_HOUR_ET"), 22),
    ttl: num(env("ALERT_TTL_MIN"), 10),
    maxEach: num(env("ALERT_MAX_INDIVIDUAL"), 5),
    confirmMl: String(env("CONFIRM_ML") ?? "1") !== "0",
    tipMin: num(env("TIP_INTERVAL_MIN"), 5),
    nearMin: num(env("NEAR_INTERVAL_MIN"), 15),
    farMin: num(env("FAR_INTERVAL_MIN"), 60),
    propMin: num(env("PROP_INTERVAL_MIN"), 60),
    propWindow: num(env("PROP_WINDOW_HOURS"), 6),
    altCap: num(env("ALT_DAILY_CAP"), 100),
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
    MIN_EV_ML: String(pct(form.get("min_ev_ml"), 0.03)),
    MIN_EV_SPREAD: String(pct(form.get("min_ev_spread"), 0.03)),
    MIN_EV_TOTAL: String(pct(form.get("min_ev_total"), 0.03)),
    PROP_MIN_EV: String(pct(form.get("prop_min_ev"), 0.04)),
    MAX_ODDS: String(Math.round(clamp(form.get("max_odds"), 100, 500, 300))),
    ...Object.fromEntries(Object.keys(SPORTS).map((k) => [`EV_BUMP_${k}`, String(pct(form.get(`bump_${k}`), 0))])),
    ACTIVE_START_HOUR_ET: String(start),
    ACTIVE_END_HOUR_ET: String(end),
    ALERT_TTL_MIN: String(Math.round(clamp(form.get("ttl"), 0, 240, 10))),
    ALERT_MAX_INDIVIDUAL: String(Math.round(clamp(form.get("max_each"), 1, 20, 5))),
    CONFIRM_ML: form.has("confirm_ml") ? "1" : "0",
    // The scheduler wakes every 5 minutes, so 5 is the fastest any interval can be.
    TIP_INTERVAL_MIN: String(Math.round(clamp(form.get("tip_min"), 5, 240, 5))),
    NEAR_INTERVAL_MIN: String(Math.round(clamp(form.get("near_min"), 5, 240, 15))),
    FAR_INTERVAL_MIN: String(Math.round(clamp(form.get("far_min"), 5, 480, 60))),
    PROP_INTERVAL_MIN: String(Math.round(clamp(form.get("prop_min"), 5, 480, 60))),
    PROP_WINDOW_HOURS: String(clamp(form.get("prop_window"), 1, 36, 6)),
    ALT_DAILY_CAP: String(Math.round(clamp(form.get("alt_cap"), 0, 1000, 100))),
  };
}
