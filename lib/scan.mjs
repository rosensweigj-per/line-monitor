// Core scan logic: pure functions, no Netlify dependencies, so it can be tested with plain node.

export const BOOKS = {
  draftkings: "DK",
  fanduel: "FD",
  espnbet: "theScore",
  betrivers: "BetRivers",
  williamhill_us: "Caesars",
  fanatics: "Fanatics",
  hardrockbet: "Hard Rock",
};
// Fallback "open the book" links (Virginia) when the Odds API has no deep link for the bet.
// On iPhone these open the book's app if it's installed.
export const BOOK_URLS = {
  draftkings: "https://sportsbook.draftkings.com",
  fanduel: "https://sportsbook.fanduel.com",
  espnbet: "https://thescore.bet",
  betrivers: "https://va.betrivers.com",
  williamhill_us: "https://sportsbook.caesars.com/us/va/bet",
  fanatics: "https://sportsbook.fanatics.com",
  hardrockbet: "https://app.hardrock.bet",
};

/** "fanatics, Hard Rock, DK" -> Set of bookmaker keys (matches keys or labels, any case/spacing). */
export function resolveBooks(str = "") {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = new Set();
  for (const tok of str.split(",").map(norm).filter(Boolean)) {
    for (const [k, label] of Object.entries(BOOKS)) if (norm(k) === tok || norm(label) === tok) out.add(k);
  }
  return out;
}

const linkFor = (b, bm, bo, state) =>
  (bo.link || bm?.link || b.link || BOOK_URLS[b.key] || "").replace(/\{state\}/g, state);

// betmgm is reference-only (Jason has no account); pinnacle is the fair price.
export const BOOKMAKERS = [...Object.keys(BOOKS), "betmgm", "pinnacle"].join(",");
export const MARKETS = ["h2h", "spreads", "totals"];

export const SPORTS = {
  americanfootball_nfl: "NFL",
  americanfootball_ncaaf: "NCAAF",
  basketball_nba: "NBA",
  basketball_ncaab: "NCAAB",
  icehockey_nhl: "NHL",
  baseball_mlb: "MLB",
};

// Virginia college teams Jason can't bet on.
const VA_SCHOOLS =
  /\b(Virginia Cavaliers|Virginia Tech|James Madison|Liberty Flames|Old Dominion|Richmond Spiders|William & Mary|VMI|Norfolk St|Hampton Pirates|Radford|George Mason|Longwood)\b/i;

export const dec = (o) => (o < 0 ? 1 + 100 / -o : 1 + o / 100);
const imp = (o) => 1 / dec(o);
export const toAmerican = (p) =>
  p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);

/**
 * Find +EV prices at Jason's books vs Pinnacle's devigged fair price.
 * games: Odds API /odds response for one sport.
 */
export function findEdges(games, sportKey, opts = {}) {
  const {
    minEv = 0.03,
    minOdds = -300,
    maxOdds = 300,
    maxPinAgeMin = 45,
    now = Date.now(),
    skipBooks = new Set(),
    state = "va",
  } = opts;
  const college = /ncaa/.test(sportKey);
  const hits = [];

  for (const g of games) {
    const start = Date.parse(g.commence_time);
    if (start <= now) continue; // pre-game only
    if (college && VA_SCHOOLS.test(`${g.home_team} ${g.away_team}`)) continue;

    const pin = g.bookmakers.find((b) => b.key === "pinnacle");
    if (!pin) continue;

    for (const mk of MARKETS) {
      const pm = pin.markets.find((m) => m.key === mk);
      if (!pm || pm.outcomes.length !== 2) continue;
      const pinAge = (now - Date.parse(pm.last_update || pin.last_update)) / 60000;
      if (pinAge > maxPinAgeMin) continue;

      for (const po of pm.outcomes) {
        const other = pm.outcomes.find((o) => o !== po);
        const p = imp(po.price) / (imp(po.price) + imp(other.price));

        for (const b of g.bookmakers) {
          const label = BOOKS[b.key];
          if (!label || skipBooks.has(b.key)) continue;
          const bm = b.markets.find((m) => m.key === mk);
          const bo = bm?.outcomes.find((o) => o.name === po.name && lineOk(mk, po, o));
          if (!bo) continue;
          if (bo.price < minOdds || bo.price > maxOdds) continue;
          const ev = p * dec(bo.price) - 1;
          if (ev < minEv) continue;

          hits.push({
            key: [g.id, mk, po.name, bo.point ?? "", b.key].join("|"),
            sel: [g.id, mk, po.name].join("|"),
            sport: SPORTS[sportKey] || sportKey,
            game: `${g.away_team} @ ${g.home_team}`,
            start: g.commence_time,
            market: mk,
            pick: pickText(mk, bo),
            book: label,
            bookKey: b.key,
            link: linkFor(b, bm, bo, state),
            odds: bo.price,
            point: bo.point,
            pinPoint: po.point,
            betterLine: bo.point !== po.point,
            fair: toAmerican(p),
            pinPrice: po.price,
            ev,
            kellyQ: Math.max(0, ev / (dec(bo.price) - 1) / 4),
          });
        }
      }
    }
  }
  // Best book first for each selection; keep only the best price per selection.
  return bestPerSelection(hits);
}

// Over/under prop markets per sport: Odds API key -> [short label for alerts, name for the settings page].
export const PROP_CATALOG = {
  basketball_nba: {
    player_points: ["pts", "Points"],
    player_rebounds: ["reb", "Rebounds"],
    player_assists: ["ast", "Assists"],
    player_threes: ["3PM", "Threes made"],
    player_points_rebounds_assists: ["PRA", "Points + rebounds + assists"],
  },
  americanfootball_nfl: {
    player_pass_yds: ["pass yds", "Passing yards"],
    player_pass_tds: ["pass TDs", "Passing TDs"],
    player_pass_completions: ["completions", "Pass completions"],
    player_rush_yds: ["rush yds", "Rushing yards"],
    player_receptions: ["rec", "Receptions"],
    player_reception_yds: ["rec yds", "Receiving yards"],
    player_rush_reception_yds: ["rush+rec yds", "Rush + receiving yards"],
  },
};
// Used when a sport's props are on but none of its markets are picked.
export const PROP_DEFAULTS = {
  basketball_nba: ["player_points"],
  americanfootball_nfl: ["player_pass_yds", "player_rush_yds", "player_receptions", "player_reception_yds"],
};
export const PROP_LABELS = Object.fromEntries(
  Object.values(PROP_CATALOG).flatMap((m) => Object.entries(m).map(([k, [short]]) => [k, short]))
);

/** Which of the chosen markets to request for a sport (unknown market keys pass through to every sport). */
export function propMarketsFor(sport, chosen) {
  const mine = PROP_CATALOG[sport] || {};
  const pick = chosen.filter((m) => m in mine || !(m in PROP_LABELS));
  return pick.length ? pick : PROP_DEFAULTS[sport] || [];
}

/**
 * Player-prop edges for one event (Odds API /events/{id}/odds response).
 * Outcomes look like { name: "Over", description: "Jayson Tatum", point: 27.5, price: -115 }.
 * Uses the same better-number rule as totals: a lower Over / higher Under than Pinnacle's still counts.
 */
export function findPropEdges(event, sportKey, opts = {}) {
  const { minEv = 0.04, minOdds = -300, maxOdds = 300, maxPinAgeMin = 45, now = Date.now(), skipBooks = new Set(), state = "va" } = opts;
  if (!event?.bookmakers || Date.parse(event.commence_time) <= now) return [];
  if (/ncaa/.test(sportKey) && VA_SCHOOLS.test(`${event.home_team} ${event.away_team}`)) return [];
  const pin = event.bookmakers.find((b) => b.key === "pinnacle");
  if (!pin) return [];
  const hits = [];

  for (const pm of pin.markets) {
    const pinAge = (now - Date.parse(pm.last_update || pin.last_update)) / 60000;
    if (pinAge > maxPinAgeMin) continue;
    const pairs = new Map();
    for (const o of pm.outcomes) {
      const k = `${o.description}|${o.point}`;
      pairs.set(k, { ...pairs.get(k), [o.name]: o });
    }
    for (const pair of pairs.values()) {
      if (!pair.Over || !pair.Under) continue;
      for (const [po, other] of [[pair.Over, pair.Under], [pair.Under, pair.Over]]) {
        const p = imp(po.price) / (imp(po.price) + imp(other.price));
        for (const b of event.bookmakers) {
          const label = BOOKS[b.key];
          if (!label || skipBooks.has(b.key)) continue;
          const bm = b.markets.find((m) => m.key === pm.key);
          const bo = bm?.outcomes.find(
            (o) => o.name === po.name && o.description === po.description && lineOk("totals", po, o)
          );
          if (!bo || bo.price < minOdds || bo.price > maxOdds) continue;
          const ev = p * dec(bo.price) - 1;
          if (ev < minEv) continue;
          hits.push({
            key: [event.id, pm.key, po.description, po.name, bo.point, b.key].join("|"),
            sel: [event.id, pm.key, po.description, po.name].join("|"),
            sport: SPORTS[sportKey] || sportKey,
            game: `${event.away_team} @ ${event.home_team}`,
            start: event.commence_time,
            market: pm.key,
            pick: `${po.description} ${po.name} ${bo.point} ${PROP_LABELS[pm.key] || pm.key}`,
            book: label,
            bookKey: b.key,
            link: linkFor(b, bm, bo, state),
            odds: bo.price,
            point: bo.point,
            pinPoint: po.point,
            betterLine: bo.point !== po.point,
            fair: toAmerican(p),
            pinPrice: po.price,
            ev,
            kellyQ: Math.max(0, ev / (dec(bo.price) - 1) / 4),
          });
        }
      }
    }
  }
  return bestPerSelection(hits);
}

function bestPerSelection(hits) {
  hits.sort((a, b) => b.ev - a.ev);
  const seen = new Set();
  return hits.filter((h) => !seen.has(h.sel) && seen.add(h.sel));
}

/**
 * Does the book's outcome match Pinnacle's, or is it a strictly better number for the bettor?
 * Better numbers (more points on a spread, a lower Over / higher Under) can only win more often,
 * so Pinnacle's devigged probability at its own number is a lower bound and the EV is conservative.
 */
export function lineOk(mk, pinOutcome, bookOutcome) {
  if (mk === "h2h") return true;
  const pp = pinOutcome.point, bp = bookOutcome.point;
  if (pp == null || bp == null) return false;
  if (bp === pp) return true;
  if (mk === "spreads") return bp > pp;
  if (mk === "totals") return pinOutcome.name === "Over" ? bp < pp : bp > pp;
  return false;
}

const pt = (n) => (n > 0 ? `+${n}` : `${n}`);
function pickText(mk, o) {
  if (mk === "totals") return `${o.name} ${o.point}`;
  if (mk === "spreads") return `${o.name} ${pt(o.point)}`;
  return `${o.name} ML`;
}

export const stakeFor = (h) => Math.min(40, Math.max(10, Math.round((h.kellyQ * 1000) / 5) * 5));

export function formatHit(h) {
  const t = new Date(h.start).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const stake = stakeFor(h);
  const evTxt = `+${(h.ev * 100).toFixed(1)}%`;
  const pin = h.betterLine
    ? `fair ${fmt(h.fair)} at Pin's ${h.market === "spreads" ? pt(h.pinPoint) : h.pinPoint} (Pin ${fmt(h.pinPrice)}) · EV ≥ ${evTxt}`
    : `fair ${fmt(h.fair)} (Pin ${fmt(h.pinPrice)}) · EV ${evTxt}`;
  return (
    `${h.sport} · ${h.pick} ${fmt(h.odds)} @ ${h.book}\n` +
    `  ${pin} · ~$${stake}\n` +
    `  ${h.game} · ${t} ET`
  );
}
