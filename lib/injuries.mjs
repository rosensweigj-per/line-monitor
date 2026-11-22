// Injury status changes from ESPN's public injuries feed (free, no key). INFO ONLY: shown on alerts, edge cards and
// the check page; never changes EV, stake or grade. Pro leagues only (ESPN has no usable college injury data).
// Snapshot + rolling 24h change log live in blob "injuries".

export const ESPN_PATHS = {
  americanfootball_nfl: "football/nfl",
  basketball_nba: "basketball/nba",
  icehockey_nhl: "hockey/nhl",
  baseball_mlb: "baseball/mlb",
};
// Key positions per sport (null = every player counts; ESPN's NBA feed has no starter/minutes data).
export const KEY_POS = {
  americanfootball_nfl: ["QB", "RB", "WR", "TE"],
  basketball_nba: null,
  icehockey_nhl: ["G"],
  baseball_mlb: ["SP"],
};
const CACHE_MS = 5 * 60e3;
const LOG_MS = 24 * 3600e3;
const SHOW_MS = 12 * 3600e3;
const NEWS_MS = 60 * 60e3;

const nm = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nick = (team) => nm(team).split(" ").pop();
/** Same team? Full name, or same nickname ("LA Clippers" = "Los Angeles Clippers", "Montréal" = "Montreal"). */
export const sameTeam = (a, b) => !!a && !!b && (nm(a) === nm(b) || nick(a) === nick(b));

const SHORT = { questionable: "Q", doubtful: "D", out: "Out", "injured reserve": "IR", "day to day": "DTD", active: "Active", probable: "P", suspension: "Susp" };
export const shortStatus = (s) => (s == null ? "" : SHORT[nm(s)] || String(s));

/** ESPN injuries JSON -> flat entries. Tolerant of missing fields. */
export function parseFeed(json, sport) {
  const out = [];
  for (const t of json?.injuries || []) {
    const team = t.displayName || t.team?.displayName || "";
    for (const i of t.injuries || []) {
      const a = i.athlete || {};
      const player = a.displayName || a.fullName || "";
      if (!team || !player) continue;
      const status = (typeof i.status === "string" ? i.status : i.status?.name || i.status?.type?.description || i.type?.description) || "";
      out.push({
        sport, team, player,
        abbr: a.team?.abbreviation || t.abbreviation || t.team?.abbreviation || "",
        pos: a.position?.abbreviation || "",
        status, date: i.date || "",
        comment: i.shortComment || "",
      });
    }
  }
  return out;
}

const keyOf = (e) => `${e.sport}|${nm(e.team)}|${nm(e.player)}`;

/**
 * Diff a sport's new entries against its previous snapshot map (key -> entry).
 * A change: newly listed (from null), status changed, or dropped off the report (to "Cleared").
 * Players only count as cleared if their team is still in the feed (a team vanishing is treated as a feed gap).
 */
export function diffInjuries(prevMap, entries, now) {
  const at = new Date(now).toISOString();
  const next = Object.fromEntries(entries.map((e) => [keyOf(e), e]));
  const changes = [];
  const pick = (e) => ({ sport: e.sport, team: e.team, abbr: e.abbr, player: e.player, pos: e.pos, comment: e.comment, at });
  for (const [k, e] of Object.entries(next)) {
    const p = prevMap[k];
    if (!p) changes.push({ ...pick(e), from: null, to: e.status });
    else if (nm(p.status) !== nm(e.status)) changes.push({ ...pick(e), from: p.status, to: e.status });
  }
  const teamsNow = new Set(entries.map((e) => nm(e.team)));
  for (const [k, p] of Object.entries(prevMap)) {
    if (!next[k] && teamsNow.has(nm(p.team))) changes.push({ ...pick(p), from: p.status, to: "Cleared", comment: "" });
  }
  return { next, changes };
}

/**
 * Poll ESPN for the given sports (those with a game in the next 6h), at most once per 5 min per sport.
 * The first snapshot of a sport is a baseline (no changes logged). Never throws.
 * deps: fetchJSON(url) -> parsed JSON.
 */
export async function updateInjuries({ store, sports, fetchJSON, now = Date.now(), log = () => {} }) {
  const data = (await store.get("injuries", { type: "json" })) || { snap: {}, log: [] };
  data.snap ||= {}; data.log ||= [];
  const stats = {};
  let dirty = false;
  for (const sport of sports) {
    const path = ESPN_PATHS[sport];
    if (!path) continue;
    const prev = data.snap[sport];
    if (prev && now - prev.at < CACHE_MS) { stats[sport] = "cached"; continue; }
    try {
      const entries = parseFeed(await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`), sport);
      if (!entries.length) { stats[sport] = "empty feed (kept last snapshot)"; continue; }
      if (!prev) {
        data.snap[sport] = { at: now, map: Object.fromEntries(entries.map((e) => [keyOf(e), e])) };
        stats[sport] = `baseline ${entries.length}`;
      } else {
        const { next, changes } = diffInjuries(prev.map || {}, entries, now);
        data.snap[sport] = { at: now, map: next };
        data.log.push(...changes);
        stats[sport] = `${entries.length} listed, ${changes.length} changes`;
      }
      dirty = true;
    } catch (e) {
      stats[sport] = `error: ${e.message}`;
      log(`[injuries ${sport}] ${e.message}`);
    }
  }
  if (dirty) {
    data.log = data.log.filter((c) => now - Date.parse(c.at) < LOG_MS).slice(-1000);
    await store.setJSON("injuries", data);
  }
  return { stats, data };
}

const isKey = (c) => { const k = KEY_POS[c.sport]; return !k || k.includes(String(c.pos).toUpperCase()); };
const teamsOf = (h) => String(h.game || "").split(" @ ");
const lastName = (p) => { const parts = String(p).split(" "); return parts.length > 1 && /^(jr|sr|ii|iii|iv)\.?$/i.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1); };
const etTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const abbrOf = (c) => c.abbr || nick(c.team).toUpperCase().slice(0, 4);
const fmt = (c) => `${abbrOf(c)} ${lastName(c.player)}${c.pos ? ` ${c.pos}` : ""}: ${c.from == null ? `listed ${shortStatus(c.to)}` : `${shortStatus(c.from)} → ${c.to === "Cleared" ? "off report" : shortStatus(c.to)}`} (${etTime(c.at)})`;

/** Changes for either team in this hit's game, newest first. */
function gameChanges(h, data, now, windowMs) {
  const [away, home] = teamsOf(h);
  return (data?.log || []).filter((c) => c.sport === h.sportKey && now - Date.parse(c.at) < windowMs && (sameTeam(c.team, away) || sameTeam(c.team, home)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * One "🩹" line for a hit: up to 3 status changes for either team in the last 12h, key positions first.
 * Player props: the player's own current status first, then same-team same-position changes.
 */
export function injuryLine(h, data, now = Date.now()) {
  if (!h || !ESPN_PATHS[h.sportKey] || !data) return "";
  const all = gameChanges(h, data, now, SHOW_MS);
  const parts = [];
  const used = new Set();
  if (h.player) {
    const mine = Object.values(data.snap?.[h.sportKey]?.map || {}).find((e) => nm(e.player) === nm(h.player));
    const myChange = all.find((c) => nm(c.player) === nm(h.player));
    if (myChange) { parts.push(fmt(myChange)); used.add(myChange); }
    else if (mine) parts.push(`${abbrOf(mine)} ${lastName(mine.player)}${mine.pos ? ` ${mine.pos}` : ""}: ${shortStatus(mine.status)}`);
    const pos = (mine || myChange)?.pos, team = (mine || myChange)?.team;
    if (pos && team) for (const c of all) if (!used.has(c) && c.pos === pos && sameTeam(c.team, team) && nm(c.player) !== nm(h.player)) { parts.push(fmt(c)); used.add(c); }
  }
  const rest = all.filter((c) => !used.has(c)).sort((a, b) => isKey(b) - isKey(a));
  for (const c of rest) { if (parts.length >= 3) break; parts.push(fmt(c)); }
  return parts.length ? `🩹 ${parts.slice(0, 3).join(" · ")}` : "";
}

/** Minutes since the newest key-position change for either team (within 60 min), else null. */
export function newsMinutes(h, data, now = Date.now()) {
  if (!h || !ESPN_PATHS[h.sportKey] || !data) return null;
  const c = gameChanges(h, data, now, NEWS_MS).find(isKey);
  return c ? Math.max(0, Math.round((now - Date.parse(c.at)) / 60000)) : null;
}

/** Flags (same shape as bet/note flags) for pages and alerts. */
export function injuryFlags(h, data, now = Date.now()) {
  const flags = [];
  const mins = newsMinutes(h, data, now);
  if (mins != null) flags.push({ level: "news", text: `⚠️ news ${mins} min ago — check the consensus line before betting` });
  const line = injuryLine(h, data, now);
  if (line) flags.push({ level: "injury", text: line });
  return flags;
}

export const loadInjuries = async (store) => {
  try { return (await store.get("injuries", { type: "json" })) || null; } catch { return null; }
};
