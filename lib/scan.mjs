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
          if (!label) continue;
          const bm = b.markets.find((m) => m.key === mk);
          const bo = bm?.outcomes.find((o) => o.name === po.name && o.point === po.point);
          if (!bo) continue;
          if (bo.price < minOdds || bo.price > maxOdds) continue;
          const ev = p * dec(bo.price) - 1;
          if (ev < minEv) continue;

          hits.push({
            key: [g.id, mk, po.name, po.point ?? "", b.key].join("|"),
            sport: SPORTS[sportKey] || sportKey,
            game: `${g.away_team} @ ${g.home_team}`,
            start: g.commence_time,
            market: mk,
            pick: pickText(mk, po, g),
            book: label,
            odds: bo.price,
            fair: toAmerican(p),
            pinPrice: po.price,
            ev,
            kellyQ: Math.max(0, (p * dec(bo.price) - 1) / (dec(bo.price) - 1) / 4),
          });
        }
      }
    }
  }
  // Best book first for each selection; keep only the best price per selection.
  hits.sort((a, b) => b.ev - a.ev);
  const seen = new Set();
  return hits.filter((h) => {
    const sel = h.key.split("|").slice(0, 4).join("|");
    if (seen.has(sel)) return false;
    seen.add(sel);
    return true;
  });
}

function pickText(mk, o, g) {
  if (mk === "totals") return `${o.name} ${o.point}`;
  const team = o.name;
  if (mk === "spreads") return `${team} ${o.point > 0 ? "+" : ""}${o.point}`;
  return `${team} ML`;
}

export function formatHit(h) {
  const t = new Date(h.start).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const stake = Math.min(40, Math.max(10, Math.round((h.kellyQ * 1000) / 5) * 5));
  return (
    `${h.sport} · ${h.pick} ${fmt(h.odds)} @ ${h.book}\n` +
    `  fair ${fmt(h.fair)} (Pin ${fmt(h.pinPrice)}) · EV +${(h.ev * 100).toFixed(1)}% · ~$${stake}\n` +
    `  ${h.game} · ${t} ET`
  );
}
