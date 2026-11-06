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
  espnbet: "https://sportsbook.thescore.bet/",
  betrivers: "https://va.betrivers.com",
  williamhill_us: "https://sportsbook.caesars.com/us/va/bet/", // app claims /us/va/bet/* only
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

/**
 * Where an "Open <book>" button goes. Books in `shortcutBooks` run an iPhone Shortcut named "Open <label>"
 * (for apps like BetRivers whose web links never open the app); otherwise the bet's deep link, else the book's site.
 */
export function openLink(bookKey, link, shortcutBooks = new Set()) {
  if (shortcutBooks.has(bookKey) && BOOKS[bookKey]) {
    return `shortcuts://run-shortcut?name=${encodeURIComponent(`Open ${BOOKS[bookKey]}`)}`;
  }
  return [link, BOOK_URLS[bookKey]].find((u) => /^https:\/\//.test(u || "")) || null;
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
    minEvByMarket = {},
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
          if (ev < (minEvByMarket[mk] ?? minEv)) continue;

          hits.push({
            key: [g.id, mk, po.name, bo.point ?? "", b.key].join("|"),
            sel: [g.id, mk, po.name].join("|"),
            sportKey,
            eventId: g.id,
            side: po.name,
            pinUpdated: pm.last_update || pin.last_update,
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
            sportKey,
            eventId: event.id,
            side: po.name,
            player: po.description,
            pinUpdated: pm.last_update || pin.last_update,
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

// EV in whole tenths of a percent, so tiers match the EV shown in alerts (4.95% shows as 5.0% and is a 5% bet).
const evPct = (h) => Math.round(h.ev * 1000) / 10;

/** True for 12%+ edges: usually a stale Pinnacle price or news (injury) the market hasn't caught. */
export const needsVerify = (h) => evPct(h) >= 12;

/**
 * Stake rules. Base by EV (better-number alerts size off the EV floor, which is what h.ev holds):
 *   <3% $5 (only reachable if a threshold is set below 3%), 3–4.9% $10, 5–7.9% $15, 8–11.9% $25, 12%+ $30 cap.
 * Then: odds +200 or longer -> half; NCAAF spreads -> max $10; round to nearest $5, minimum $5.
 */
export function stakeFor(h) {
  const e = evPct(h);
  let stake = e >= 12 ? 30 : e >= 8 ? 25 : e >= 5 ? 15 : e >= 3 ? 10 : 5;
  if (h.odds >= 200) stake /= 2;
  if (h.market === "spreads" && (h.sportKey === "americanfootball_ncaaf" || h.sport === "NCAAF")) stake = Math.min(stake, 10);
  return Math.max(5, Math.round(stake / 5) * 5);
}

/** Grade by EV only: 8%+ A+, 6–7.9% A, 4–5.9% B, 3–3.9% C, below 3% D. */
export function gradeFor(h) {
  const e = evPct(h);
  return e >= 8 ? "A+" : e >= 6 ? "A" : e >= 4 ? "B" : e >= 3 ? "C" : "D";
}

export function formatHit(h) {
  const t = new Date(h.start).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const evTxt = `+${(h.ev * 100).toFixed(1)}%`;
  const pin = h.betterLine
    ? `fair ${fmt(h.fair)} at Pin's ${h.market === "spreads" ? pt(h.pinPoint) : h.pinPoint} (Pin ${fmt(h.pinPrice)}) · EV ≥ ${evTxt}`
    : `fair ${fmt(h.fair)} (Pin ${fmt(h.pinPrice)}) · EV ${evTxt}`;
  return (
    `${h.pick} ${fmt(h.odds)} @ ${h.book}\n` +
    `  ${pin} · Grade ${gradeFor(h)} · stake $${stakeFor(h)}\n` +
    (needsVerify(h) ? "  VERIFY: stale Pinnacle / injury?\n" : "") +
    `  ${h.sport} · ${h.game} · ${t} ET`
  );
}

/**
 * Re-price one bet from a fresh single-event pull: q = { market, side, player?, bookKey }.
 * Returns { status: "ok", hit } with current EV (any sign), or { status: "started" | "nopin" | "nobook" }.
 */
export function recheck(event, sportKey, q, now = Date.now()) {
  if (!event?.bookmakers) return { status: "nobook" };
  if (Date.parse(event.commence_time) <= now) return { status: "started" };
  const pin = event.bookmakers.find((b) => b.key === "pinnacle");
  if (!pin?.markets?.some((m) => m.key === q.market)) return { status: "nopin" };
  const opts = {
    now,
    minEv: -Infinity,
    minOdds: -Infinity,
    maxOdds: Infinity,
    maxPinAgeMin: Infinity,
    skipBooks: new Set(Object.keys(BOOKS).filter((k) => k !== q.bookKey)),
  };
  const hits = q.market.startsWith("player_")
    ? findPropEdges(event, sportKey, opts)
    : findEdges([event], sportKey, opts);
  const hit = hits.find((h) => h.market === q.market && h.side === q.side && (h.player || "") === (q.player || ""));
  return hit ? { status: "ok", hit } : { status: "nobook" };
}

/** Link to the /check page for a hit. Everything needed to re-price the bet rides in the URL. */
export function checkUrl(base, token, h, at = Date.now()) {
  if (!token || !h.eventId || !h.sportKey) return null;
  const q = new URLSearchParams({
    token, s: h.sportKey, e: h.eventId, m: h.market, n: h.side, b: h.bookKey,
    o: String(h.odds), f: String(h.fair), x: (h.ev).toFixed(4), t: String(at),
  });
  if (h.player) q.set("d", h.player);
  if (h.point != null) q.set("p", String(h.point));
  if (h.pinPrice != null) q.set("pp", String(h.pinPrice));
  return `${(base || "").replace(/\/$/, "")}/check?${q}`;
}


/** Parse a /check link's query (inverse of checkUrl). `ok` is false when something needed is missing. */
export function parseCheckParams(q) {
  const n = (k) => (q.has(k) && q.get(k) !== "" && !Number.isNaN(Number(q.get(k))) ? Number(q.get(k)) : null);
  const out = {
    then: { odds: n("o"), point: n("p"), fair: n("f"), pinPrice: n("pp"), ev: n("x"), at: n("t"), bookKey: q.get("b") || "" },
    sport: q.get("s") || "",
    eventId: q.get("e") || "",
    market: q.get("m") || "",
    side: q.get("n") || "",
    player: q.get("d") || "",
  };
  out.ok = /^[a-z0-9_]+$/.test(out.sport) && /^[a-z0-9_]+$/.test(out.market) && /^[A-Za-z0-9_-]+$/.test(out.eventId) &&
    !!out.side && out.then.bookKey in BOOKS;
  return out;
}
