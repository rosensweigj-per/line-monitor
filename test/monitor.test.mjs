import { test } from "node:test";
import assert from "node:assert/strict";
import { dec, toAmerican, findEdges, findPropEdges, lineOk, formatHit, resolveBooks } from "../lib/scan.mjs";
import { runMonitor } from "../lib/run.mjs";
import { renderEdges } from "../lib/page.mjs";

const NOW = Date.parse("2026-11-04T20:00:00Z"); // 3 PM ET
const START = new Date(NOW + 2 * 3600e3).toISOString();
const fresh = new Date(NOW - 5 * 60e3).toISOString();

const game = (markets, extra = {}) => ({
  id: "g1",
  commence_time: START,
  home_team: "Celtics",
  away_team: "Knicks",
  bookmakers: [
    { key: "pinnacle", last_update: fresh, markets: markets.pin },
    ...Object.entries(markets.books || {}).map(([key, m]) => ({ key, markets: m })),
  ],
  ...extra,
});
const h2h = (home, away) => ({ key: "h2h", outcomes: [{ name: "Celtics", price: home }, { name: "Knicks", price: away }] });
const spread = (pt, home, away) => ({
  key: "spreads",
  outcomes: [{ name: "Celtics", price: home, point: -pt }, { name: "Knicks", price: away, point: pt }],
});
const total = (pt, over, under) => ({
  key: "totals",
  outcomes: [{ name: "Over", price: over, point: pt }, { name: "Under", price: under, point: pt }],
});

test("odds conversions", () => {
  assert.equal(dec(-110).toFixed(4), "1.9091");
  assert.equal(dec(150), 2.5);
  assert.equal(toAmerican(0.5), -100);
  assert.equal(toAmerican(0.6), -150);
  assert.equal(toAmerican(0.4), 150);
});

test("devig + EV on a moneyline", () => {
  // Pin -110/-110 -> fair 50%. FD +110 -> EV = 0.5 * 2.1 - 1 = 5%.
  const hits = findEdges([game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110, -130)] } })], "basketball_nba", { now: NOW });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pick, "Celtics ML");
  assert.equal(hits[0].book, "FD");
  assert.ok(Math.abs(hits[0].ev - 0.05) < 1e-9);
  assert.equal(hits[0].betterLine, false);
});

test("below threshold, out of odds range, started games, stale Pin, MGM are skipped", () => {
  const g = (books, extra) => game({ pin: [h2h(-110, -110)], books }, extra);
  assert.equal(findEdges([g({ fanduel: [h2h(102, -130)] })], "basketball_nba", { now: NOW }).length, 0); // EV 1%
  assert.equal(findEdges([g({ betmgm: [h2h(120, -140)] })], "basketball_nba", { now: NOW }).length, 0); // reference only
  assert.equal(findEdges([g({ fanduel: [h2h(120, -140)] }, { commence_time: new Date(NOW - 1).toISOString() })], "basketball_nba", { now: NOW }).length, 0);
  const stale = g({ fanduel: [h2h(120, -140)] });
  stale.bookmakers[0].last_update = new Date(NOW - 60 * 60e3).toISOString();
  assert.equal(findEdges([stale], "basketball_nba", { now: NOW }).length, 0);
  const longshot = game({ pin: [h2h(-500, 400)], books: { fanduel: [h2h(-450, 500)] } });
  assert.equal(findEdges([longshot], "basketball_nba", { now: NOW }).length, 0);
});

test("Virginia schools are skipped in college only", () => {
  const va = game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110, -130)] } }, { home_team: "Virginia Tech Hokies" });
  assert.equal(findEdges([va], "basketball_ncaab", { now: NOW }).length, 0);
  assert.equal(findEdges([va], "basketball_nba", { now: NOW }).length, 1);
});

test("keeps only the best book per selection", () => {
  const hits = findEdges(
    [game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(106, -130)], draftkings: [h2h(112, -135)] } })],
    "basketball_nba",
    { now: NOW }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].book, "DK");
});

test("lineOk: only equal or strictly better numbers", () => {
  const pinDog = { name: "Knicks", point: 3 };
  assert.ok(lineOk("spreads", pinDog, { point: 3 }));
  assert.ok(lineOk("spreads", pinDog, { point: 3.5 }));
  assert.ok(!lineOk("spreads", pinDog, { point: 2.5 }));
  const pinFav = { name: "Celtics", point: -3 };
  assert.ok(lineOk("spreads", pinFav, { point: -2.5 }));
  assert.ok(!lineOk("spreads", pinFav, { point: -3.5 }));
  assert.ok(lineOk("totals", { name: "Over", point: 220.5 }, { point: 219.5 }));
  assert.ok(!lineOk("totals", { name: "Over", point: 220.5 }, { point: 221.5 }));
  assert.ok(lineOk("totals", { name: "Under", point: 220.5 }, { point: 221.5 }));
  assert.ok(!lineOk("totals", { name: "Under", point: 220.5 }, { point: 219.5 }));
});

test("better spread number at a book is flagged with conservative EV", () => {
  // Pin Knicks +3 -110/-110 (fair 50%). DK has Knicks +3.5 +105 -> EV >= 2.5%; FD Knicks +2.5 +120 must be ignored.
  const hits = findEdges(
    [game({
      pin: [spread(3, -110, -110)],
      books: { draftkings: [spread(3.5, -125, 105)], fanduel: [spread(2.5, -140, 120)] },
    })],
    "basketball_nba",
    { now: NOW, minEv: 0.02 }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].book, "DK");
  assert.equal(hits[0].pick, "Knicks +3.5");
  assert.equal(hits[0].betterLine, true);
  assert.equal(hits[0].pinPoint, 3);
  assert.match(formatHit(hits[0]), /EV ≥ \+2\.5%/);
  assert.match(formatHit(hits[0]), /at Pin's \+3/);
});

test("better total number works for Over and Under", () => {
  const hits = findEdges(
    [game({ pin: [total(220.5, -110, -110)], books: { fanduel: [total(219.5, 106, -130)], draftkings: [total(221.5, -130, 106)] } })],
    "basketball_nba",
    { now: NOW }
  );
  assert.deepEqual(hits.map((h) => `${h.pick} ${h.book}`).sort(), ["Over 219.5 FD", "Under 221.5 DK"]);
});

// --- runMonitor ---

function harness(envs, games, propEvent = null) {
  const mem = {};
  const pushes = [];
  const calls = [];
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    calls.push(url);
    if (/\/events\/[^/]+\/odds/.test(url)) return new Response(JSON.stringify(propEvent || {}), { headers: { "x-requests-remaining": "8999" } });
    if (url.includes("/events")) return new Response(JSON.stringify([{ id: "g1", commence_time: START }]));
    if (url.includes("/odds")) return new Response(JSON.stringify(games), { headers: { "x-requests-remaining": "9000" } });
    pushes.push({ url, body: Object.fromEntries(new URLSearchParams(opts.body)) });
    return new Response("{}");
  };
  const env = (k) => ({ ODDS_API_KEY: "x", PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u", SPORTS: "basketball_nba", PROP_SPORTS: "off", ...envs })[k];
  return { mem, pushes, calls, run: (now = NOW, force = false) => runMonitor({ store, env, now, force, log() {} }) };
}
const edgeGame = () => game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110, -130)] } });

test("quiet hours: stops at 10 PM ET by default, overridable, and 0 is respected", async () => {
  const at = (h) => Date.parse("2026-11-04T05:00:00Z") + h * 3600e3; // midnight EST + h hours
  assert.match((await harness({}, []).run(at(22))).skipped, /quiet hours/);
  assert.equal((await harness({}, []).run(at(21) + 45 * 60e3)).skipped, undefined);
  assert.match((await harness({}, []).run(at(8))).skipped, /quiet hours/);
  assert.equal((await harness({ ACTIVE_END_HOUR_ET: "24" }, []).run(at(22))).skipped, undefined);
  assert.equal((await harness({ ACTIVE_START_HOUR_ET: "0" }, []).run(at(8))).skipped, undefined);
});

test("pushes once, dedupes, re-alerts on a better price, and saves open edges", async () => {
  const games = [edgeGame()];
  const h = harness({}, games);
  await h.run();
  assert.equal(h.pushes.length, 1);
  assert.match(h.pushes[0].body.message, /Celtics ML \+110 @ FD/);
  assert.equal(h.pushes[0].body.priority, "1"); // 5% EV -> high
  assert.equal(h.mem.edges.basketball_nba.hits.length, 1);

  await h.run(NOW + 15 * 60e3, true);
  assert.equal(h.pushes.length, 1, "same price should not re-alert");

  games[0].bookmakers[1].markets = [h2h(115, -135)];
  await h.run(NOW + 30 * 60e3, true);
  assert.equal(h.pushes.length, 2, "better price re-alerts");
});

test("MIN_EV=0 is honored instead of falling back to 3%", async () => {
  const g = game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(102, -130)] } }); // EV 1%
  assert.equal((await harness({}, [g]).run()).newHits.length, 0);
  assert.equal((await harness({ MIN_EV: "0" }, [g]).run()).newHits.length, 1);
});

test("alert body stays under Pushover's 1024-char limit", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110 + i, -130)] } }),
    id: `g${i}`,
    home_team: `Home Team Number ${i}`,
    away_team: `Away Team Number ${i}`,
  }));
  many.forEach((g, i) => g.bookmakers.forEach((b) => b.markets.forEach((m) => (m.outcomes[0].name = `Home Team Number ${i}`))));
  const h = harness({}, many);
  await h.run();
  assert.ok(h.pushes[0].body.message.length <= 1024);
  assert.match(h.pushes[0].body.message, /\+\d+ more/);
});

test("edges page lists future edges, best first, and escapes text", () => {
  const hits = findEdges([edgeGame()], "basketball_nba", { now: NOW });
  const old = { ...hits[0], start: new Date(NOW - 1).toISOString(), pick: "Old ML" };
  const html = renderEdges({
    edges: { basketball_nba: { at: NOW - 10 * 60e3, hits: [old, { ...hits[0], game: "<script>x</script>" }] } },
    state: { remaining: 8123 },
    lastRun: { at: new Date(NOW - 5 * 60e3).toISOString() },
    now: NOW,
  });
  assert.match(html, /Celtics ML <b>\+110<\/b>/);
  assert.doesNotMatch(html, /Old ML/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /8123 Odds API credits/);
  assert.match(renderEdges({ edges: null, now: NOW }), /No open edges/);
});

// --- props ---

const prop = (player, pt, over, under) => [
  { name: "Over", description: player, point: pt, price: over },
  { name: "Under", description: player, point: pt, price: under },
];
const propEvent = () => ({
  id: "g1",
  commence_time: START,
  home_team: "Celtics",
  away_team: "Knicks",
  bookmakers: [
    { key: "pinnacle", last_update: fresh, markets: [{ key: "player_points", outcomes: [...prop("Jayson Tatum", 27.5, -110, -110), ...prop("Jalen Brunson", 26.5, -110, -110)] }] },
    // FD: Tatum Over 27.5 +110 (EV 5%); Brunson Under 27.5 -105 at a better number than Pin's 26.5 (EV >= 2.4%, below 4%)
    { key: "fanduel", markets: [{ key: "player_points", outcomes: [...prop("Jayson Tatum", 27.5, 110, -140), ...prop("Jalen Brunson", 27.5, -125, -105)] }] },
    // DK: Brunson Under 27.5 +112 -> EV >= 6%; Tatum Over 28.5 +150 is a worse number, must be ignored
    { key: "draftkings", markets: [{ key: "player_points", outcomes: [...prop("Jayson Tatum", 28.5, 150, -190), ...prop("Jalen Brunson", 27.5, -150, 112)] }] },
  ],
});

test("prop edges: devig per player, better numbers count, worse numbers ignored", () => {
  const hits = findPropEdges(propEvent(), "basketball_nba", { now: NOW });
  assert.deepEqual(hits.map((h) => `${h.pick} ${h.book}`), ["Jalen Brunson Under 27.5 pts DK", "Jayson Tatum Over 27.5 pts FD"]);
  assert.equal(hits[0].betterLine, true);
  assert.match(formatHit(hits[0]), /at Pin's 26\.5 .*EV ≥ \+6\.0%/);
  assert.equal(findPropEdges({ ...propEvent(), commence_time: new Date(NOW - 1).toISOString() }, "basketball_nba", { now: NOW }).length, 0);
});

test("props: pulled for games within the window, hourly, and alerted with main lines", async () => {
  const h = harness({ PROP_SPORTS: "basketball_nba" }, [], propEvent());
  const s = await h.run();
  assert.equal(h.calls.filter((u) => u.includes("/events/g1/odds")).length, 1);
  assert.match(h.calls.find((u) => u.includes("/events/g1/odds")), /markets=player_points/);
  assert.match(s.props.basketball_nba, /1 games, 2 edges/);
  assert.match(h.pushes[0].body.message, /Jayson Tatum Over 27\.5 pts \+110 @ FD/);
  assert.equal(h.mem.edges["props:g1"].hits.length, 2);
  assert.equal(s.remaining, 8999);

  await h.run(NOW + 15 * 60e3);
  assert.equal(h.calls.filter((u) => u.includes("/events/g1/odds")).length, 1, "not due again for an hour");
  await h.run(NOW + 60 * 60e3);
  assert.equal(h.calls.filter((u) => u.includes("/events/g1/odds")).length, 2);
});

test("props: games beyond the window are not pulled", async () => {
  const h = harness({ PROP_SPORTS: "basketball_nba", PROP_WINDOW_HOURS: "1" }, [], propEvent());
  const s = await h.run();
  assert.equal(h.calls.filter((u) => u.includes("/events/g1/odds")).length, 0);
  assert.match(s.props.basketball_nba, /no games due/);
});

// --- books on/off, links, cadence ---

test("resolveBooks matches keys and labels in any case", () => {
  assert.deepEqual([...resolveBooks("fanatics, Hard Rock, dk, nope")].sort(), ["draftkings", "fanatics", "hardrockbet"]);
  assert.deepEqual([...resolveBooks("thescore,caesars")].sort(), ["espnbet", "williamhill_us"]);
  assert.equal(resolveBooks("").size, 0);
});

test("BOOKS_OFF drops a book and the next-best book wins", async () => {
  const g = game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(106, -130)], draftkings: [h2h(112, -135)] } });
  const s = await harness({ BOOKS_OFF: "DK" }, [g]).run();
  assert.deepEqual(s.newHits.map((h) => h.book), ["FD"]);
  assert.deepEqual(s.booksOff, ["draftkings"]);
  assert.equal((await harness({ BOOKS_OFF: "dk,fd" }, [g]).run()).newHits.length, 0);
});

test("alert links to the best book: API deep link with {state}, else book homepage", async () => {
  const g = game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110, -130)] } });
  g.bookmakers[1].markets[0].outcomes[0].link = "https://{state}.sportsbook.fanduel.com/addToBetslip?x=1";
  const h = harness({}, [g]);
  await h.run();
  assert.equal(h.pushes[0].body.url, "https://va.sportsbook.fanduel.com/addToBetslip?x=1");
  assert.equal(h.pushes[0].body.url_title, "Open FD");
  assert.ok(h.calls.some((u) => u.includes("/odds") && u.includes("includeLinks=true")));

  const h2 = harness({}, [game({ pin: [h2h(-110, -110)], books: { draftkings: [h2h(110, -130)] } })]);
  await h2.run();
  assert.equal(h2.pushes[0].body.url, "https://sportsbook.draftkings.com");
});

test("checks every 5 min within 1h of a game, every 15 within 4h", async () => {
  const pulls = (h) => h.calls.filter((u) => /\/odds\?/.test(u)).length;
  // START is 2h out: 15-minute cadence
  const h = harness({}, [edgeGame()]);
  await h.run(); await h.run(NOW + 5 * 60e3); await h.run(NOW + 15 * 60e3);
  assert.equal(pulls(h), 2);
  // 50 minutes before START: 5-minute cadence
  const t = NOW + 70 * 60e3;
  const h2 = harness({}, [edgeGame()]);
  await h2.run(t); await h2.run(t + 5 * 60e3); await h2.run(t + 10 * 60e3);
  assert.equal(pulls(h2), 3);
});

test("edges page has a Scan now button and shows scan results and errors", () => {
  const html = renderEdges({
    edges: {},
    lastRun: { at: new Date(NOW).toISOString(), newHits: [{}, {}], sports: { icehockey_nhl: "error: HTTP 500 boom", basketball_nba: "pulled 3 games, 0 edges" } },
    now: NOW,
    token: "a b&c",
    scanned: true,
  });
  assert.match(html, /<form method="post" action="\/edges\?token=a%20b%26c"/);
  assert.match(html, /Scan now/);
  assert.match(html, /Scan done · 2 new alerts sent/);
  assert.match(html, /icehockey_nhl: error: HTTP 500 boom/);
  assert.doesNotMatch(html, /basketball_nba: pulled/);
  assert.doesNotMatch(renderEdges({ edges: {}, now: NOW, token: "t" }), /Scan done/);
});

// --- settings page ---
import { currentSettings, parseSettingsForm, withSettings } from "../lib/settings.mjs";
import { renderSettings } from "../lib/page.mjs";

test("settings form round-trips and overrides env vars in a run", async () => {
  const form = new URLSearchParams();
  for (const k of ["draftkings", "fanduel", "espnbet", "betrivers", "williamhill_us", "hardrockbet"]) form.set(`book_${k}`, "on");
  form.set("sport_basketball_nba", "on");
  form.set("sport_icehockey_nhl", "on");
  form.set("props_basketball_nba", "on");
  form.set("prop_player_points", "on");
  form.set("prop_player_rebounds", "on");
  form.set("min_ev_ml", "2.5");
  form.set("min_ev_spread", "1.5");
  form.set("min_ev_total", "2");
  form.set("prop_min_ev", "5");
  form.set("start", "10");
  form.set("end", "23");
  const saved = parseSettingsForm(form);
  assert.deepEqual(saved, {
    BOOKS_OFF: "fanatics",
    BOOK_SHORTCUTS: "",
    SPORTS: "basketball_nba,icehockey_nhl",
    PROP_SPORTS: "basketball_nba",
    PROP_MARKETS: "player_points,player_rebounds",
    MIN_EV_ML: "0.025",
    MIN_EV_SPREAD: "0.015",
    MIN_EV_TOTAL: "0.02",
    PROP_MIN_EV: "0.05",
    ACTIVE_START_HOUR_ET: "10",
    ACTIVE_END_HOUR_ET: "23",
    ALERT_TTL_MIN: "10",
    TIP_INTERVAL_MIN: "5",
    NEAR_INTERVAL_MIN: "15",
    FAR_INTERVAL_MIN: "60",
    PROP_INTERVAL_MIN: "60",
    PROP_WINDOW_HOURS: "6",
  });

  const cur = currentSettings(withSettings((k) => ({ MIN_EV: "0.03", BOOKS_OFF: "dk" })[k], saved));
  assert.equal(cur.minEvMl, 0.025);
  assert.equal(cur.minEvSpread, 0.015);
  assert.deepEqual([...cur.booksOff], ["fanatics"]);
  const html = renderSettings({ cur, token: "t", custom: true });
  assert.match(html, /name="book_fanatics">/);
  assert.match(html, /name="book_draftkings" checked/);
  assert.match(html, /name="min_ev_ml"[^>]*value="2.5"/);
  assert.match(html, /name="min_ev_spread"[^>]*value="1.5"/);
  assert.match(html, /<option value="23" selected>11 PM/);
  assert.match(html, /Reset to Netlify values/);

  // saved settings beat env vars inside runMonitor
  const g = game({ pin: [h2h(-110, -110)], books: { fanatics: [h2h(115, -135)], fanduel: [h2h(110, -130)] } });
  const h = harness({}, [g]);
  h.mem.settings = { BOOKS_OFF: "fanatics" };
  const s = await h.run();
  assert.deepEqual(s.newHits.map((x) => x.book), ["FD"]);
});

test("settings form guards bad input", () => {
  const s = parseSettingsForm(new URLSearchParams({ min_ev_ml: "abc", prop_min_ev: "-4", start: "20", end: "8" }));
  assert.equal(s.MIN_EV_ML, "0.03");
  assert.equal(s.PROP_MIN_EV, "0");
  assert.equal(s.ACTIVE_END_HOUR_ET, "21");
  assert.equal(s.SPORTS, "off");
  assert.equal(s.PROP_SPORTS, "off");
  assert.equal(s.BOOKS_OFF, "draftkings,fanduel,espnbet,betrivers,williamhill_us,fanatics,hardrockbet");
});

test("NFL props: own markets per sport, defaults when none picked", async () => {
  const { propMarketsFor } = await import("../lib/scan.mjs");
  const chosen = ["player_points", "player_pass_yds", "player_receptions"];
  assert.deepEqual(propMarketsFor("basketball_nba", chosen), ["player_points"]);
  assert.deepEqual(propMarketsFor("americanfootball_nfl", chosen), ["player_pass_yds", "player_receptions"]);
  assert.deepEqual(propMarketsFor("americanfootball_nfl", ["player_points"]), ["player_pass_yds", "player_rush_yds", "player_receptions", "player_reception_yds"]);

  const form = new URLSearchParams({ props_americanfootball_nfl: "on", props_basketball_nba: "on", prop_player_rebounds: "on" });
  const saved = parseSettingsForm(form);
  assert.equal(saved.PROP_SPORTS, "basketball_nba,americanfootball_nfl");
  assert.equal(saved.PROP_MARKETS, "player_rebounds,player_pass_yds,player_rush_yds,player_receptions,player_reception_yds");
  const html = renderSettings({ cur: currentSettings(withSettings(() => undefined, saved)), token: "t" });
  assert.match(html, /NFL player props/);
  assert.match(html, /name="props_americanfootball_nfl" checked/);
  assert.match(html, /name="prop_player_receptions" checked> Receptions/);
  assert.match(html, /name="prop_player_points"> Points/);
});

test("NFL props run: requests only NFL markets and formats the pick", async () => {
  const ev = {
    id: "g1", commence_time: START, home_team: "Chiefs", away_team: "Bills",
    bookmakers: [
      { key: "pinnacle", last_update: fresh, markets: [{ key: "player_reception_yds", outcomes: prop("Travis Kelce", 54.5, -110, -110) }] },
      { key: "fanduel", markets: [{ key: "player_reception_yds", outcomes: prop("Travis Kelce", 54.5, 110, -140) }] },
    ],
  };
  const h = harness({ PROP_SPORTS: "americanfootball_nfl", PROP_MARKETS: "player_points,player_reception_yds", SPORTS: "americanfootball_nfl" }, [], ev);
  const s = await h.run();
  const url = h.calls.find((u) => u.includes("/events/g1/odds"));
  assert.match(url, /\/americanfootball_nfl\/events\/g1\/odds/);
  assert.match(url, /markets=player_reception_yds&/);
  assert.match(s.props.americanfootball_nfl, /1 games, 1 edges/);
  assert.match(h.pushes[0].body.message, /Travis Kelce Over 54\.5 rec yds \+110 @ FD\n.*\n  NFL · Bills @ Chiefs/);
});

test("edges page: each card has an Open <book> link (deep link, else book site, never non-https)", () => {
  const base = findEdges([edgeGame()], "basketball_nba", { now: NOW })[0];
  const html = renderEdges({
    edges: { nba: { at: NOW, hits: [
      { ...base, link: "https://sportsbook.fanduel.com/addToBetslip?a=1&b=2" },
      { ...base, sel: "x", pick: "Old ML", book: "DK", bookKey: "draftkings", link: undefined },
      { ...base, sel: "y", pick: "Bad ML", book: "Weird", bookKey: "nope", link: "javascript:alert(1)" },
    ] } },
    now: NOW,
  });
  assert.match(html, /<a class="open" href="https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?a=1&#38;b=2"[^>]*>Open FD<\/a>/);
  assert.match(html, /href="https:\/\/sportsbook\.draftkings\.com"[^>]*>Open DK/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /Open Weird/);
});

// --- alert expiry + re-check ---
import { recheck, checkUrl } from "../lib/scan.mjs";
import { renderCheck } from "../lib/page.mjs";

test("alerts expire, show when found, and link to the check page", async () => {
  const h = harness({ URL: "https://jason-line-alerts.netlify.app", RUN_TOKEN: "tok" }, [edgeGame()]);
  await h.run();
  const b = h.pushes[0].body;
  assert.equal(b.ttl, "600");
  assert.equal(b.timestamp, String(Math.floor(NOW / 1000)));
  assert.match(b.message, /Found 3:00 PM ET · expires in 10 min/);
  const u = new URL(b.url);
  assert.equal(u.origin + u.pathname, "https://jason-line-alerts.netlify.app/check");
  assert.equal(u.searchParams.get("token"), "tok");
  assert.equal(u.searchParams.get("s"), "basketball_nba");
  assert.equal(u.searchParams.get("e"), "g1");
  assert.equal(u.searchParams.get("m"), "h2h");
  assert.equal(u.searchParams.get("n"), "Celtics");
  assert.equal(u.searchParams.get("b"), "fanduel");
  assert.equal(u.searchParams.get("o"), "110");
  assert.match(b.url_title, /Check price, then open FD/);

  const h2 = harness({ ALERT_TTL_MIN: "0" }, [edgeGame()]); // no URL -> falls back to book link, no ttl
  await h2.run();
  assert.equal(h2.pushes[0].body.ttl, undefined);
  assert.equal(h2.pushes[0].body.url, "https://sportsbook.fanduel.com");
});

test("recheck: still +EV, Pinnacle moved against, book line gone, started", () => {
  const ev = edgeGame();
  const q = { market: "h2h", side: "Celtics", bookKey: "fanduel" };
  let r = recheck(ev, "basketball_nba", q, NOW);
  assert.equal(r.status, "ok");
  assert.ok(Math.abs(r.hit.ev - 0.05) < 1e-9);
  // Pinnacle moves to Celtics +105 / Knicks -125: Celtics fair drops, same FD +110 is now -EV-ish
  ev.bookmakers[0].markets = [h2h(115, -135)];
  r = recheck(ev, "basketball_nba", q, NOW);
  assert.ok(r.hit.ev < 0.01);
  // other books ignored even if better
  ev.bookmakers.push({ key: "draftkings", markets: [h2h(150, -170)] });
  assert.equal(recheck(ev, "basketball_nba", q, NOW).hit.book, "FD");
  assert.equal(recheck(ev, "basketball_nba", { ...q, bookKey: "betrivers" }, NOW).status, "nobook");
  assert.equal(recheck({ ...ev, commence_time: new Date(NOW - 1).toISOString() }, "basketball_nba", q, NOW).status, "started");
  // props
  const pr = recheck(propEvent(), "basketball_nba", { market: "player_points", side: "Under", player: "Jalen Brunson", bookKey: "draftkings" }, NOW);
  assert.equal(pr.hit.pick, "Jalen Brunson Under 27.5 pts");
});

test("check page: verdicts and what changed", () => {
  const base = findEdges([edgeGame()], "basketball_nba", { now: NOW })[0];
  const then = { odds: 110, fair: -100, pinPrice: -110, ev: 0.05, at: NOW - 10 * 60e3, bookKey: "fanduel", point: null };
  let html = renderCheck({ then, result: { status: "ok", hit: base }, token: "t", now: NOW, book: "FD" });
  assert.match(html, /Still \+EV · \+5\.0%/);
  assert.match(html, /Nothing meaningful moved/);
  assert.match(html, /Alert \(10m ago\)/);
  const moved = { ...base, fair: 120, pinPrice: 115, ev: -0.045 };
  html = renderCheck({ then, result: { status: "ok", hit: moved }, token: "t", now: NOW, book: "FD" });
  assert.match(html, /Gone · -4\.5% EV/);
  assert.match(html, /Pinnacle moved against this side: fair -100 → \+120/);
  assert.match(renderCheck({ then, result: { status: "nobook" }, now: NOW, book: "FD" }), /FD no longer offers this line/);
  assert.match(renderCheck({ then, result: { status: "started" }, now: NOW, book: "FD" }), /Game has started/);
  assert.match(renderCheck({ then, error: "HTTP 500", now: NOW, book: "FD" }), /Couldn't re-check: HTTP 500/);
  // edges cards link to /check
  const edges = renderEdges({ edges: { nba: { at: NOW, hits: [base] } }, token: "t", now: NOW });
  assert.match(edges, /href="\/check\?token=t&#38;s=basketball_nba[^"]*">Check price/);
  assert.equal(checkUrl("", "", base), null);
});

test("check links round-trip for moneyline, spread, total, and props (h2h has a digit)", async () => {
  const { parseCheckParams } = await import("../lib/scan.mjs");
  const ml = findEdges([edgeGame()], "americanfootball_ncaaf", { now: NOW })[0];
  const sp = findEdges([game({ pin: [spread(3, -110, -110)], books: { hardrockbet: [spread(3.5, -125, 105)] } })], "basketball_nba", { now: NOW, minEv: 0.02 })[0];
  const tot = findEdges([game({ pin: [total(220.5, -110, -110)], books: { fanduel: [total(219.5, 106, -130)] } })], "basketball_nba", { now: NOW })[0];
  const pr = findPropEdges(propEvent(), "basketball_nba", { now: NOW })[0];
  for (const h of [ml, sp, tot, pr]) {
    const url = new URL(checkUrl("https://x.netlify.app", "tok", h, NOW));
    const c = parseCheckParams(url.searchParams);
    assert.ok(c.ok, `${h.market} link should parse`);
    assert.equal(c.market, h.market);
    assert.equal(c.side, h.side);
    assert.equal(c.player, h.player || "");
    assert.equal(c.eventId, h.eventId);
    assert.equal(c.then.bookKey, h.bookKey);
    assert.equal(c.then.odds, h.odds);
    assert.equal(c.then.point, h.point ?? null);
  }
  assert.equal(parseCheckParams(new URLSearchParams("m=h2h&s=x")).ok, false);
});

test("Shortcut books: buttons run the iPhone Shortcut; others use https links; Caesars VA path matches the app", async () => {
  const { openLink, BOOK_URLS } = await import("../lib/scan.mjs");
  const sc = new Set(["betrivers"]);
  assert.equal(openLink("betrivers", "https://va.betrivers.com/x", sc), "shortcuts://run-shortcut?name=Open%20BetRivers");
  assert.equal(openLink("fanduel", "https://sportsbook.fanduel.com/x", sc), "https://sportsbook.fanduel.com/x");
  assert.equal(openLink("draftkings", "javascript:x", sc), "https://sportsbook.draftkings.com");
  assert.match(BOOK_URLS.williamhill_us, /\/us\/va\/bet\/$/);

  const base = { ...findEdges([edgeGame()], "basketball_nba", { now: NOW })[0], book: "BetRivers", bookKey: "betrivers" };
  const html = renderEdges({ edges: { nba: { at: NOW, hits: [base] } }, now: NOW, shortcutBooks: sc });
  assert.match(html, /href="shortcuts:\/\/run-shortcut\?name=Open%20BetRivers"[^>]*>Open BetRivers/);
  const chk = renderCheck({ then: { bookKey: "betrivers", odds: 110 }, result: { status: "ok", hit: base }, now: NOW, book: "BetRivers", shortcutBooks: sc });
  assert.match(chk, /shortcuts:\/\/run-shortcut\?name=Open%20BetRivers/);

  const saved = parseSettingsForm(new URLSearchParams({ sc_betrivers: "on", book_betrivers: "on" }));
  assert.equal(saved.BOOK_SHORTCUTS, "betrivers");
  assert.match(renderSettings({ cur: currentSettings(withSettings(() => undefined, saved)), token: "t" }), /name="sc_betrivers" checked/);

  // Pushover fallback (no site URL) honors shortcuts too
  const g = game({ pin: [h2h(-110, -110)], books: { betrivers: [h2h(110, -130)] } });
  const h = harness({ BOOK_SHORTCUTS: "betrivers" }, [g]);
  await h.run();
  assert.equal(h.pushes[0].body.url, "shortcuts://run-shortcut?name=Open%20BetRivers");
});

test("separate EV thresholds for moneyline, spreads, totals (fall back to MIN_EV)", async () => {
  const { minEvFor } = await import("../lib/settings.mjs");
  const env = (m) => (k) => m[k];
  assert.equal(minEvFor(env({}), "h2h"), 0.03);
  assert.equal(minEvFor(env({ MIN_EV: "0.025" }), "spreads"), 0.025);
  assert.equal(minEvFor(env({ MIN_EV: "0.025", MIN_EV_SPREAD: "0.015" }), "spreads"), 0.015);
  assert.equal(minEvFor(env({ MIN_EV_TOTAL: "0" }), "totals"), 0);
  assert.equal(minEvFor(env({}), "player_points"), 0.04);

  // Same 2% edge on a ML and a spread: only the spread clears when spreads are at 1.5% and ML at 3%.
  const g = game({
    pin: [h2h(-110, -110), spread(3, -110, -110)],
    books: { fanduel: [h2h(104, -130), spread(3, -130, 104)] },
  });
  const s = await harness({ MIN_EV_SPREAD: "0.015" }, [g]).run();
  assert.deepEqual(s.newHits.map((h) => h.market), ["spreads"]);
  const s2 = await harness({}, [g]).run();
  assert.equal(s2.newHits.length, 0);
});

test("scan intervals are editable in settings, clamped to the 5-minute scheduler, and drive the cadence", async () => {
  const saved = parseSettingsForm(new URLSearchParams({ tip_min: "2", near_min: "10", far_min: "120", prop_min: "30", prop_window: "3" }));
  assert.equal(saved.TIP_INTERVAL_MIN, "5");
  assert.equal(saved.NEAR_INTERVAL_MIN, "10");
  assert.equal(saved.FAR_INTERVAL_MIN, "120");
  assert.equal(saved.PROP_INTERVAL_MIN, "30");
  assert.equal(saved.PROP_WINDOW_HOURS, "3");
  const html = renderSettings({ cur: currentSettings(withSettings(() => undefined, saved)), token: "t" });
  assert.match(html, /name="near_min"[^>]*value="10"/);
  assert.match(html, /name="prop_window"[^>]*value="3"/);

  // START is 2h out -> "within 4 hours" cadence, now 10 min from saved settings
  const pulls = (h) => h.calls.filter((u) => /\/odds\?/.test(u)).length;
  const h = harness({}, [edgeGame()]);
  h.mem.settings = { NEAR_INTERVAL_MIN: "10" };
  await h.run(); await h.run(NOW + 5 * 60e3); await h.run(NOW + 10 * 60e3);
  assert.equal(pulls(h), 2);
});

// --- stake + grade rules ---
import { stakeFor, gradeFor } from "../lib/scan.mjs";

test("stake and grade rules", () => {
  const h = (ev, odds = -110, extra = {}) => ({ ev, odds, market: "h2h", sport: "NBA", sportKey: "basketball_nba", ...extra });
  // base tiers
  assert.equal(stakeFor(h(0.030)), 10);
  assert.equal(stakeFor(h(0.049)), 10);
  assert.equal(stakeFor(h(0.050)), 15);
  assert.equal(stakeFor(h(0.0795)), 25, "7.95% shows as 8.0% -> 8% tier");
  assert.equal(stakeFor(h(0.079)), 15);
  assert.equal(stakeFor(h(0.080)), 25);
  assert.equal(stakeFor(h(0.119)), 25);
  assert.equal(stakeFor(h(0.12)), 30);
  assert.equal(stakeFor(h(0.25)), 30);
  assert.equal(stakeFor(h(0.02)), 5, "below 3% (lowered threshold) -> $5");
  // longshot halving, then rounding to nearest $5 (min $5)
  assert.equal(stakeFor(h(0.046, 200)), 5);   // the example: Kentucky ML +200, EV 4.6% -> $5
  assert.equal(stakeFor(h(0.046, 199)), 10);
  assert.equal(stakeFor(h(0.06, 250)), 10);   // 15/2 = 7.5 -> 10
  assert.equal(stakeFor(h(0.09, 300)), 15);   // 25/2 = 12.5 -> 15
  assert.equal(stakeFor(h(0.13, 210)), 15);   // 30/2
  // NCAAF spreads cap $10 (after longshot halving)
  assert.equal(stakeFor(h(0.09, -110, { market: "spreads", sportKey: "americanfootball_ncaaf", sport: "NCAAF" })), 10);
  assert.equal(stakeFor(h(0.09, -110, { market: "h2h", sportKey: "americanfootball_ncaaf", sport: "NCAAF" })), 25);
  assert.equal(stakeFor(h(0.09, -110, { market: "spreads" })), 25);
  // grades
  assert.deepEqual([0.08, 0.079, 0.06, 0.059, 0.04, 0.039, 0.03, 0.02].map((e) => gradeFor(h(e))), ["A+", "A", "A", "B", "B", "C", "C", "D"]);
});

test("alert line format with grade, stake and VERIFY label", () => {
  const base = {
    pick: "Kentucky ML", odds: 200, book: "BetRivers", fair: 187, pinPrice: 178, ev: 0.046, market: "h2h",
    sport: "NCAAB", sportKey: "basketball_ncaab", game: "Tennessee @ Kentucky", start: START, betterLine: false,
  };
  const lines = formatHit(base).split("\n");
  assert.equal(lines[0], "Kentucky ML +200 @ BetRivers");
  assert.equal(lines[1], "  fair +187 (Pin +178) · EV +4.6% · Grade B · stake $5");
  assert.match(lines[2], /^  NCAAB · Tennessee @ Kentucky · /);
  const hot = formatHit({ ...base, odds: 150, ev: 0.135 });
  assert.match(hot, /EV \+13\.5% · Grade A\+ · stake \$30\n  VERIFY: stale Pinnacle \/ injury\?\n/);
  // better number sizes off the floor
  const bn = formatHit({ ...base, pick: "Kentucky +3.5", odds: -110, market: "spreads", betterLine: true, pinPoint: 3, ev: 0.051 });
  assert.match(bn, /EV ≥ \+5\.1% · Grade B · stake \$15/);
});

test("check page shows grade and stake (now and at alert), skip when not +EV", () => {
  const hit = { ...findEdges([edgeGame()], "basketball_nba", { now: NOW })[0] }; // EV 5% at +110 -> B, $15
  const then = { odds: 110, fair: -100, pinPrice: -110, ev: 0.05, at: NOW - 60e3, bookKey: "fanduel", market: "h2h", sportKey: "basketball_nba" };
  let html = renderCheck({ then, result: { status: "ok", hit }, now: NOW, book: "FD" });
  assert.match(html, /Still \+EV · \+5\.0%<div class="stake">Grade B · stake \$15<\/div>/);
  assert.match(html, /Grade · stake<\/span><span class="cmp"><span class="then">B · \$15<\/span><span class="now">B · \$15/);
  html = renderCheck({ then, result: { status: "ok", hit: { ...hit, ev: 0.01 } }, now: NOW, book: "FD" });
  assert.match(html, /Skip, or at most \$5/);
  assert.match(html, /<span class="now">skip<\/span>/);
  html = renderCheck({ then, result: { status: "ok", hit: { ...hit, ev: 0.14 } }, now: NOW, book: "FD" });
  assert.match(html, /VERIFY: stale Pinnacle/);
});

test("settings page is grouped into collapsible sections with summaries; field names unchanged", () => {
  const cur = currentSettings(withSettings((k) => ({ BOOKS_OFF: "fanatics", BOOK_SHORTCUTS: "betrivers" })[k], {}));
  const html = renderSettings({ cur, token: "t" });
  assert.equal((html.match(/<details>/g) || []).length, 4);
  assert.match(html, /<span class="st">Books<\/span><span class="sum">6 of 7 on · 1 via Shortcut/);
  assert.match(html, /<span class="sum">ML 3% · Spr 3% · Tot 3% · Props 4%/);
  assert.match(html, /9 AM–10 PM ET · 5\/15\/60 min · props 60 min/);
  for (const name of ["book_fanatics", "sc_betrivers", "sport_basketball_nba", "props_americanfootball_nfl", "prop_player_points",
    "min_ev_ml", "min_ev_spread", "min_ev_total", "prop_min_ev", "ttl", "start", "end", "tip_min", "near_min", "far_min", "prop_min", "prop_window"]) {
    assert.match(html, new RegExp(`name="${name}"`), name);
  }
  assert.match(html, /name="book_fanatics">/);
  assert.match(html, /name="sc_betrivers" checked/);
});
