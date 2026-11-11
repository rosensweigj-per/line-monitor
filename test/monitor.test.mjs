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
  const env = (k) => ({ ODDS_API_KEY: "x", PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u", SPORTS: "basketball_nba", PROP_SPORTS: "off", CONFIRM_ML: "0", ...envs })[k];
  return { mem, pushes, calls, run: (now = NOW, force = false) => runMonitor({ store, env, now, force, log() {} }) };
}
const edgeGame = () => game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110, -130)] } });

test("quiet hours: stops at 10 PM ET by default, overridable, and 0 is respected", async () => {
  const at = (h) => Date.parse("2026-11-04T05:00:00Z") + h * 3600e3; // midnight EST + h hours
  assert.match((await harness({}, []).run(at(22))).skipped, /outside scan hours/);
  assert.equal((await harness({}, []).run(at(21) + 45 * 60e3)).skipped, undefined);
  assert.match((await harness({}, []).run(at(8))).skipped, /outside scan hours/);
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

test("one alert per edge (top 5, each with its own check link), then one summary for the rest", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...game({ pin: [h2h(-110, -110)], books: { fanduel: [h2h(110 + i, -130)] } }),
    id: `g${i}`,
    home_team: `Home Team Number ${i}`,
    away_team: `Away Team Number ${i}`,
  }));
  many.forEach((g, i) => g.bookmakers.forEach((b) => b.markets.forEach((m) => (m.outcomes[0].name = `Home Team Number ${i}`))));
  const h = harness({ URL: "https://jason-line-alerts.netlify.app", RUN_TOKEN: "tok" }, many);
  await h.run();
  assert.equal(h.pushes.length, 6, "5 individual + 1 summary");
  const singles = h.pushes.slice(0, 5).map((p) => p.body);
  // best first, each its own pick and its own /check link for that game
  assert.match(singles[0].title, /^\+14\.5% A\+ · Home Team Number 19 ML \+129 @ FD$/);
  assert.deepEqual(singles.map((b) => new URL(b.url).searchParams.get("e")), ["g19", "g18", "g17", "g16", "g15"]);
  assert.ok(singles.every((b) => b.message.length <= 1024 && /Check price, then open FD/.test(b.url_title)));
  assert.ok(singles.every((b) => (b.message.match(/ @ FD\n/g) || []).length === 1), "one edge per message");
  const summary = h.pushes[5].body;
  assert.equal(summary.title, "+15 more edges");
  assert.equal(summary.url, "https://jason-line-alerts.netlify.app/edges?token=tok");
  assert.ok(summary.message.length <= 1024);
  // setting changes the count
  const h2 = harness({ ALERT_MAX_INDIVIDUAL: "2" }, many);
  await h2.run();
  assert.equal(h2.pushes.length, 3);
  // recent alerts log keeps every alerted edge for the edges page
  assert.equal(h.mem.alerts.length, 20);
  assert.equal(h.mem.alerts[0].alertedAt, NOW);
});

test("edges page lists recent alerts, marks ones the latest scan no longer has, and drops started games", () => {
  const [a, b] = findEdges([edgeGame(), { ...game({ pin: [h2h(-110, -110)], books: { draftkings: [h2h(112, -135)] } }), id: "g2" }], "basketball_nba", { now: NOW });
  const old = { ...a, key: "old", start: new Date(NOW - 1).toISOString(), pick: "Started ML" };
  const html = renderEdges({
    edges: { nba: { at: NOW, hits: [a] } },
    alerts: [{ ...b, alertedAt: NOW - 12 * 60e3 }, { ...a, alertedAt: NOW - 20 * 60e3 }, { ...old, alertedAt: NOW }],
    token: "t", now: NOW,
  });
  assert.match(html, /<h2>Recent alerts<\/h2>/);
  const recent = html.slice(html.indexOf("Recent alerts"));
  assert.match(recent, /alerted 12m ago · <b>not in latest scan<\/b>/);
  assert.match(recent, /alerted 20m ago · still in latest scan/);
  assert.doesNotMatch(recent, /Started ML/);
  assert.match(recent, /href="\/check\?token=t&#38;s=basketball_nba&#38;e=g2/);
  assert.doesNotMatch(renderEdges({ edges: {}, now: NOW }), /Recent alerts/);
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
  assert.match(s.props.basketball_nba, /pulled props for 1 games \(Pinnacle priced 1\), 2 edges/);
  assert.ok(h.pushes.some((p) => /Jayson Tatum Over 27\.5 pts \+110 @ FD/.test(p.body.message)));
  assert.equal(h.pushes.length, 2, "one alert per prop edge");
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
  assert.match(html, /NHL: HTTP 500 boom · Odds API problem, retries next scan/);
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
    ALERT_MAX_INDIVIDUAL: "5",
    CONFIRM_ML: "0",
    TIP_INTERVAL_MIN: "5",
    NEAR_INTERVAL_MIN: "15",
    FAR_INTERVAL_MIN: "60",
    PROP_INTERVAL_MIN: "60",
    PROP_WINDOW_HOURS: "6",
    ALT_DAILY_CAP: "100",
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
  assert.match(s.props.americanfootball_nfl, /pulled props for 1 games \(Pinnacle priced 1\), 1 edges/);
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
    pick: "Kentucky ML", odds: 200, book: "BetRivers", bookKey: "betrivers", fair: 187, pinPrice: 178, ev: 0.046, market: "h2h",
    sport: "NCAAB", sportKey: "basketball_ncaab", game: "Tennessee @ Kentucky", start: START, betterLine: false,
  };
  const lines = formatHit(base).split("\n");
  assert.equal(lines[0], "Kentucky ML +200 @ BR");
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

test("check page header names the sport", () => {
  const then = { odds: 270, ev: 0.046, bookKey: "espnbet", market: "h2h", sportKey: "basketball_ncaab" };
  assert.match(renderCheck({ then, result: { status: "nobook" }, now: NOW, book: "theScore", pick: "UConn Huskies ML" }),
    /class="status"><b>NCAAB<\/b> · UConn Huskies ML @ theScore/);
});

// --- "already bet" flags (Bet Tracker sheet, read-only) ---
import { gameKeyFor, parseOpenBets, betFlags, bookKeyFromName, isMiddle, loadOpenBets, READONLY_SCOPE } from "../lib/bets.mjs";
import { generateKeyPairSync } from "node:crypto";

// The Pending tab's header row (A:T), per the spec and the live sheet.
const HEADER = ["sheetRow", "id", "book", "sport", "betType", "pick", "odds", "stake", "potentialPayout", "legs", "status", "loggedAt",
  "fairOdds", "evPct", "closeFair", "clvPct", "funding", "bonusEarned", "gameDate", "gameKey"];
const betRow = (o) => HEADER.map((h) => (o[h] ?? ""));

test("gameKey matches the sheet's format for ML, spread, total and props", () => {
  const ml = findEdges([edgeGame()], "basketball_nba", { now: NOW })[0];
  assert.equal(gameKeyFor(ml), "g1|h2h|Celtics|");
  const sp = findEdges([game({ pin: [spread(3, -110, -110)], books: { fanduel: [spread(3.5, -125, 105)] } })], "basketball_nba", { now: NOW, minEv: 0.02 })[0];
  assert.equal(gameKeyFor(sp), "g1|spreads|Knicks|3.5");
  const tot = findEdges([game({ pin: [total(220.5, -110, -110)], books: { fanduel: [total(219.5, 106, -130)] } })], "basketball_nba", { now: NOW })[0];
  assert.equal(gameKeyFor(tot), "g1|totals|Over|219.5");
  const pr = findPropEdges(propEvent(), "basketball_nba", { now: NOW }).find((h) => h.player === "Jayson Tatum");
  assert.equal(gameKeyFor(pr), "g1|player_points|Jayson Tatum Over|27.5");
});

test("parseOpenBets: Pending tab — blank status counts, 'none' placeholder, bonus rows, date serials ignored", () => {
  assert.deepEqual(parseOpenBets([HEADER, ["none"]]), []);
  const open = parseOpenBets([
    HEADER,
    betRow({ sheetRow: "445", id: "x", book: "FanDuel", odds: "800", stake: "50", status: "", funding: "bonus", gameDate: "46332", gameKey: "g1|h2h|Celtics|" }),
    betRow({ sheetRow: "446", id: "y", book: "DraftKings", odds: "-850", stake: "358", status: "pending", funding: "cash", gameDate: "46332", gameKey: "g1|h2h|Knicks|" }),
  ]);
  assert.deepEqual(open.map((b) => [b.id, b.bonus, b.sheetRow]), [["x", true, "445"], ["y", false, "446"]]);
  const f = betFlags({ eventId: "g1", market: "h2h", side: "Celtics", bookKey: "draftkings", book: "DK" }, open);
  assert.deepEqual(f.map((x) => x.level), ["conflict", "same"]);
  assert.match(f[0].text, /Knicks ML -850 \$358/);
  assert.match(f[1].text, /^✓ You have \$50 bonus on this \(FanDuel \+800\)$/);
});

test("parseOpenBets: header-driven columns, pending only, gameKey required, book names mapped", () => {
  const open = parseOpenBets([
    HEADER,
    betRow({ id: "a", book: "theScore Bet", odds: "108", stake: "10", status: "pending", gameKey: "g1|spreads|Knicks|3.5" }),
    betRow({ id: "b", book: "DraftKings", odds: "-110", stake: "$12.50", status: "win", gameKey: "g1|h2h|Celtics|" }),
    betRow({ id: "c", book: "FanDuel", odds: "-110", stake: "10", status: "pending", gameKey: "" }),
    betRow({ id: "d", book: "Hard Rock Bet", odds: "120", stake: "5", status: "Pending", gameKey: "g1|player_points|Jayson Tatum Under|27.5" }),
  ]);
  assert.deepEqual(open.map((b) => b.id), ["a", "d"]);
  assert.equal(open[0].bookKey, "espnbet");
  assert.equal(open[0].point, 3.5);
  assert.equal(open[1].bookKey, "hardrockbet");
  assert.equal(open[1].player, "Jayson Tatum");
  assert.equal(open[1].ou, "Under");
  assert.equal(bookKeyFromName("BetRivers"), "betrivers");
  assert.equal(bookKeyFromName("Caesars"), "williamhill_us");
  assert.equal(bookKeyFromName("bet365"), "");
  // reordered columns still work
  const swapped = [["gameKey", "status", "stake", "book", "odds"], ["g1|h2h|Celtics|", "pending", "7", "FanDuel", "+110"]];
  assert.equal(parseOpenBets(swapped)[0].stake, 7);
});

test("betFlags: same side, other side, same-book conflict, same game other market", () => {
  const hit = { eventId: "g1", market: "spreads", side: "Knicks", point: 3.5, bookKey: "fanduel", book: "FD" };
  const open = (rows) => parseOpenBets([HEADER, ...rows.map(betRow)]);

  let f = betFlags(hit, open([{ book: "DraftKings", odds: "-110", stake: "10", status: "pending", gameKey: "g1|spreads|Knicks|3" }]));
  assert.deepEqual(f.map((x) => x.level), ["same"]);
  assert.match(f[0].text, /^✓ You have \$10 on this \(DraftKings -110 at \+3\)$/);

  f = betFlags(hit, open([{ book: "BetRivers", odds: "-105", stake: "20", status: "pending", gameKey: "g1|spreads|Celtics|-2.5" }]));
  assert.deepEqual(f.map((x) => x.level), ["opposite"]);
  assert.match(f[0].text, /⚠ You have the other side \(BetRivers Celtics -2\.5 -105 \$20\) — possible middle\/hedge/);

  f = betFlags(hit, open([{ book: "FanDuel", odds: "-110", stake: "10", status: "pending", gameKey: "g1|spreads|Celtics|-3.5" }]));
  assert.deepEqual(f.map((x) => x.level), ["conflict"]);
  assert.match(f[0].text, /⛔ Other side already at FD: Celtics -3\.5 -110 \$10 — never opposite sides at one book/);

  f = betFlags(hit, open([{ book: "Caesars", odds: "105", stake: "10", status: "pending", gameKey: "g1|totals|Over|220.5" }]));
  assert.deepEqual(f.map((x) => x.level), ["event"]);
  assert.match(f[0].text, /ℹ Also on this game: Over 220\.5 \+105 \(Caesars\)/);

  // props: other player = same game info; same player other half = opposite
  const ph = { eventId: "g1", market: "player_points", side: "Over", player: "Jayson Tatum", point: 27.5, bookKey: "fanduel", book: "FD" };
  f = betFlags(ph, open([
    { book: "DraftKings", odds: "-115", stake: "10", status: "pending", gameKey: "g1|player_points|Jayson Tatum Under|28.5" },
    { book: "DraftKings", odds: "-110", stake: "5", status: "pending", gameKey: "g1|player_points|Jalen Brunson Over|26.5" },
  ]));
  assert.deepEqual(f.map((x) => x.level), ["opposite", "event"]);
  assert.match(f[0].text, /middle\/hedge/); // Over 27.5 + Under 28.5 -> 28 wins both

  assert.deepEqual(betFlags({ ...hit, eventId: "zzz" }, open([{ book: "FanDuel", status: "pending", gameKey: "g1|h2h|Celtics|" }])), []);
  assert.equal(isMiddle({ market: "spreads", point: 3.5 }, { point: -3.5 }), false);
  assert.equal(isMiddle({ market: "totals", side: "Under", point: 221 }, { point: 221 }), false);
});

test("sheet is only read: readonly scope, values GET, flags land in the alert, failures never block alerts", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const games = [edgeGame()];
  const h = harness({ GOOGLE_SA_EMAIL: "monitor@proj.iam.gserviceaccount.com", GOOGLE_SA_KEY: pem.replace(/\n/g, "\\n") }, games);
  const inner = globalThis.fetch;
  const google = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const jwt = new URLSearchParams(opts.body).get("assertion");
      google.push({ u, method: opts.method, claim: JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) });
      return new Response(JSON.stringify({ access_token: "tok" }));
    }
    if (u.startsWith("https://sheets.googleapis.com/")) {
      google.push({ u, method: opts.method || "GET" });
      return new Response(JSON.stringify({ values: [HEADER, betRow({ book: "BetRivers", odds: "105", stake: "10", status: "pending", gameKey: "g1|h2h|Celtics|" })] }));
    }
    return inner(url, opts);
  };
  const s = await h.run();
  assert.equal(google[0].claim.scope, READONLY_SCOPE);
  assert.ok(google.every((c) => c.u.startsWith("https://oauth2.googleapis.com/token") || c.method === "GET"), "only GETs to Sheets");
  assert.ok(google.some((c) => /\/spreadsheets\/1-B7rhvOf9bto3u-P_cgtyBJ2I87n13i9bbtxvANyWrY\/values\/Pending!A%3AT\?/.test(c.u)));
  assert.ok(!google.some((c) => /:batchUpdate|:append|:clear|values\/[^?]*\?.*valueInputOption/.test(c.u)));
  assert.match(h.pushes[0].body.message, /✓ You have \$10 on this \(BetRivers \+105\)/);
  assert.deepEqual(s.bets, { open: 1 });

  // sheet down -> alert still goes out, error reported
  globalThis.fetch = async (url, opts) => (String(url).includes("googleapis") ? new Response("nope", { status: 500 }) : inner(url, opts));
  const h2 = harness({ GOOGLE_SA_EMAIL: "x@y", GOOGLE_SA_KEY: pem }, [edgeGame()]);
  const inner2 = globalThis.fetch; // harness replaced fetch; wrap again
  globalThis.fetch = async (url, opts) => (String(url).includes("googleapis") ? new Response("nope", { status: 500 }) : inner2(url, opts));
  const s2 = await h2.run();
  assert.equal(h2.pushes.length, 1);
  assert.match(s2.bets.error, /Google auth HTTP 500/);

  // no credentials -> feature off, no Google calls
  const off = await loadOpenBets({ get: async () => null, setJSON: async () => {} }, () => undefined);
  assert.equal(off.off, true);
});

test("edges and check pages show the flags", () => {
  const base = findEdges([edgeGame()], "basketball_nba", { now: NOW })[0];
  const flags = [{ level: "opposite", text: "⚠ You have the other side (DK Knicks ML +105 $10) — possible hedge" }];
  assert.match(renderEdges({ edges: { nba: { at: NOW, hits: [base] } }, now: NOW, flagsFor: () => flags }), /<div class="flag opposite">⚠ You have the other side/);
  assert.match(renderCheck({ then: { bookKey: "fanduel", odds: 110, sportKey: "basketball_nba" }, result: { status: "ok", hit: base }, now: NOW, book: "FD", flags }), /class="flags"><div class="flag opposite">/);
});

test("real Pending rows (11/6): UConn/Michigan boost lock and Nicholls St bonus bet flag correctly", () => {
  const open = parseOpenBets([HEADER,
    betRow({ sheetRow: "432", book: "FanDuel", odds: "119", stake: "10", status: "pending", funding: "cash", gameDate: "46332", gameKey: "a110856b340f750ba0e73fffce01d22c|spreads|Michigan Wolverines|7.5" }),
    betRow({ sheetRow: "433", book: "DraftKings", odds: "121", stake: "10", status: "pending", funding: "cash", gameDate: "46332", gameKey: "a110856b340f750ba0e73fffce01d22c|spreads|UConn Huskies|-7.5" }),
    betRow({ sheetRow: "434", book: "FanDuel", odds: "800", stake: "50", status: "pending", funding: "bonus", gameDate: "46332", gameKey: "c2d8d477513a55a0aa53f905d6b932cb|h2h|Nicholls St Colonels|" }),
  ]);
  // An alert for UConn -7.5 at FanDuel: same side at DK, and the other side (Michigan) at the SAME book (FD).
  const f = betFlags({ eventId: "a110856b340f750ba0e73fffce01d22c", market: "spreads", side: "UConn Huskies", point: -7.5, bookKey: "fanduel", book: "FD" }, open);
  assert.deepEqual(f.map((x) => x.level), ["conflict", "same"]);
  assert.match(f[0].text, /⛔ Other side already at FD: Michigan Wolverines \+7\.5 \+119 \$10/);
  assert.match(f[1].text, /✓ You have \$10 on this \(DraftKings \+121\)/);
  // An alert for UAB ML at Caesars: other side is the Nicholls St bonus bet.
  const g = betFlags({ eventId: "c2d8d477513a55a0aa53f905d6b932cb", market: "h2h", side: "UAB Blazers", bookKey: "williamhill_us", book: "Caesars" }, open);
  assert.match(g[0].text, /⚠ You have the other side \(FanDuel Nicholls St Colonels ML \+800 \$50 bonus\) — possible hedge/);
});

test("published CSV: parsed (quotes, commas, newlines), only GET, flags in alert, preferred over service account", async () => {
  const { parseCsv } = await import("../lib/bets.mjs");
  assert.deepEqual(parseCsv('a,b,c\n1,"x, ""y""\nz",3\r\n'), [["a", "b", "c"], ["1", 'x, "y"\nz', "3"]]);
  const csv = [HEADER.join(","),
    ['433', 'bet_1', 'DraftKings', 'NCAAB', 'spread', '"UConn -7.5 (UConn @ Michigan) — DK 30% boost, max $10"', '121', '10', '22.1', '1', 'pending', '2026-11-06T13:47:04.000Z', '', '', '', '', 'cash', '', '46332', 'g1|h2h|Celtics|'].join(","),
  ].join("\n");
  const url = "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=123&single=true&output=csv";
  const h = harness({ BET_TRACKER_CSV_URL: url, GOOGLE_SA_EMAIL: "x@y", GOOGLE_SA_KEY: "k" }, [edgeGame()]);
  const inner = globalThis.fetch;
  const csvCalls = [];
  globalThis.fetch = async (u, opts = {}) => {
    if (String(u).startsWith("https://docs.google.com/")) { csvCalls.push(opts.method); return new Response("﻿" + csv); }
    if (String(u).includes("googleapis")) throw new Error("service account should not be used when a CSV link is set");
    return inner(u, opts);
  };
  const s = await h.run();
  assert.deepEqual(csvCalls, ["GET"]);
  assert.deepEqual(s.bets, { open: 1 });
  assert.match(h.pushes[0].body.message, /✓ You have \$10 on this \(DraftKings \+121\)/);

  // a non-CSV page (link not published as CSV) reports a clear error and still alerts
  const h2 = harness({ BET_TRACKER_CSV_URL: url }, [edgeGame()]);
  const inner2 = globalThis.fetch;
  globalThis.fetch = async (u, opts = {}) => (String(u).startsWith("https://docs.google.com/") ? new Response("<!DOCTYPE html><html>") : inner2(u, opts));
  const s2 = await h2.run();
  assert.equal(h2.pushes.length, 1);
  assert.match(s2.bets.error, /publish the Pending tab as CSV/);
  const h3 = harness({ BET_TRACKER_CSV_URL: "https://evil.example/x.csv" }, [edgeGame()]);
  assert.match((await h3.run()).bets.error, /must be a docs\.google\.com/);
});

test("odds pull: 5xx with links falls back to a plain pull (retried once); errors say which request failed", async () => {
  const { RETRY_DELAY } = await import("../lib/run.mjs");
  RETRY_DELAY.ms = 1;
  const h = harness({}, [edgeGame()]);
  const inner = globalThis.fetch;
  let plainFails = 1;
  const seen = [];
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (/\/odds\?/.test(url)) {
      seen.push(url.includes("includeLinks=true") ? "links" : "plain");
      if (url.includes("includeLinks=true")) return new Response("Internal Server Error", { status: 502 });
      if (plainFails-- > 0) return new Response("Bad Gateway", { status: 502 });
    }
    return inner(u, o);
  };
  const s = await h.run();
  assert.deepEqual(seen, ["links", "plain", "plain"]);
  assert.match(s.sports.basketball_nba, /pulled 1 games, 1 edges \(no bet links this pull\)/);
  assert.equal(h.pushes.length, 1);

  // persistent failure is labeled
  const h2 = harness({}, [edgeGame()]);
  const inner2 = globalThis.fetch;
  globalThis.fetch = async (u, o) => (/\/odds\?/.test(String(u)) ? new Response("down", { status: 503 }) : inner2(u, o));
  assert.match((await h2.run()).sports.basketball_nba, /^error: odds pull: HTTP 503 down$/);
  const h3 = harness({}, [edgeGame()]);
  const inner3 = globalThis.fetch;
  globalThis.fetch = async (u, o) => (/\/events\?/.test(String(u)) ? new Response("nope", { status: 401 }) : inner3(u, o));
  assert.match((await h3.run()).sports.basketball_nba, /^error: game list: HTTP 401 nope$/);
  RETRY_DELAY.ms = 1500;
});

// --- best price lookup ---
import { teamMatches, findGames, compareBooks, renderBest } from "../lib/best.mjs";

test("best price: team search, book comparison with EV vs Pinnacle, render", () => {
  assert.ok(teamMatches("Michigan State Spartans", "mich st"));
  assert.ok(teamMatches("Michigan State Spartans", "Michigan State"));
  assert.ok(!teamMatches("Michigan Wolverines", "mich st"));
  assert.ok(!teamMatches("Michigan State Spartans", ""));
  const events = { basketball_ncaab: [
    { id: "e2", commence_time: new Date(NOW + 30 * 3600e3).toISOString(), home_team: "Duke Blue Devils", away_team: "Michigan State Spartans" },
    { id: "e1", commence_time: new Date(NOW + 2 * 3600e3).toISOString(), home_team: "Michigan State Spartans", away_team: "Oakland Golden Grizzlies" },
    { id: "e0", commence_time: new Date(NOW - 6 * 3600e3).toISOString(), home_team: "Michigan State Spartans", away_team: "Old Game" },
    { id: "x", commence_time: new Date(NOW + 3600e3).toISOString(), home_team: "Michigan Wolverines", away_team: "Ohio State Buckeyes" },
  ], americanfootball_ncaaf: [{ id: "f1", commence_time: new Date(NOW + 5 * 3600e3).toISOString(), home_team: "Indiana Hoosiers", away_team: "Michigan State Spartans" }] };
  const found = findGames(events, "mich st", NOW);
  assert.deepEqual(found.map((g) => g.event.id), ["e1", "f1", "e2"]);
  assert.equal(found[1].team, "Michigan State Spartans");

  const ev = {
    id: "e1", home_team: "Michigan State Spartans", away_team: "Oakland Golden Grizzlies",
    bookmakers: [
      { key: "pinnacle", markets: [
        { key: "h2h", outcomes: [{ name: "Michigan State Spartans", price: -110 }, { name: "Oakland Golden Grizzlies", price: -110 }] },
        { key: "spreads", outcomes: [{ name: "Michigan State Spartans", price: -110, point: -3 }, { name: "Oakland Golden Grizzlies", price: -110, point: 3 }] },
      ] },
      { key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: "Michigan State Spartans", price: 105 }] }, { key: "spreads", outcomes: [{ name: "Michigan State Spartans", price: -110, point: -3.5 }] }] },
      { key: "draftkings", markets: [{ key: "h2h", outcomes: [{ name: "Michigan State Spartans", price: -105 }] }, { key: "spreads", outcomes: [{ name: "Michigan State Spartans", price: -115, point: -2.5 }] }] },
      { key: "fanatics", markets: [{ key: "h2h", outcomes: [{ name: "Michigan State Spartans", price: 120 }] }] },
      { key: "betmgm", markets: [{ key: "h2h", outcomes: [{ name: "Michigan State Spartans", price: 150 }] }] },
    ],
  };
  const cmp = compareBooks(ev, "Michigan State Spartans", { skipBooks: new Set(["fanatics"]) });
  const ml = cmp.h2h[0];
  assert.deepEqual(ml.rows.map((r) => r.book), ["FD", "DK"], "best first; off books and MGM excluded");
  assert.ok(Math.abs(ml.rows[0].ev - 0.025) < 1e-9);
  assert.equal(ml.fair.american, -100);
  const sp = cmp.spreads[0];
  assert.deepEqual(sp.rows.map((r) => [r.book, r.point, r.ev == null ? null : +r.ev.toFixed(4), r.floor]), [["DK", -2.5, -0.0652, true], ["FD", -3.5, null, false]]);
  const html = renderBest({ q: "mich st", games: [{ sport: "basketball_ncaab", event: ev, team: "Michigan State Spartans", cmp }], token: "t", now: NOW });
  assert.match(html, /NCAAB · Oakland Golden Grizzlies @ Michigan State Spartans/);
  assert.match(html, /<div class="brow best"><span><a href="https:\/\/sportsbook\.fanduel\.com"[^>]*>FD<\/a><\/span><span><b>\+105<\/b><\/span><span class="pos">2\.5%<\/span>/);
  assert.match(html, /fair -100 \(Pin -110\)/);
  assert.match(renderBest({ q: "zzz", games: [], token: "t" }), /No upcoming game found/);
});

test("quiet-hours wake-ups keep the last real scan and show a paused note", async () => {
  const h = harness({}, [edgeGame()]);
  await h.run(); // real scan at 3 PM ET
  const night = Date.parse("2026-11-04T05:00:00Z") + 23 * 3600e3; // 11 PM ET same day
  const s = await h.run(night);
  assert.match(s.skipped, /outside scan hours \(9 AM–10 PM ET\)/);
  assert.equal(h.mem.lastRun.at, new Date(NOW).toISOString(), "last real scan time kept");
  assert.equal(h.mem.lastRun.sports.basketball_nba, "pulled 1 games, 1 edges");
  await h.run(night + 5 * 60e3); // repeated wake-ups don't lose it
  assert.equal(h.mem.lastRun.at, new Date(NOW).toISOString());
  const html = renderEdges({ edges: {}, lastRun: h.mem.lastRun, now: night + 6 * 60e3 });
  assert.match(html, /Last scan 8h 6m ago · <b>Paused: outside scan hours \(9 AM–10 PM ET\)<\/b>/);
  assert.doesNotMatch(renderEdges({ edges: {}, lastRun: h.mem.lastRun, now: night + 60 * 60e3 }), /Paused/, "stale pause note hidden");
  // first ever wake-up during quiet hours
  const h2 = harness({}, []);
  await h2.run(night);
  assert.match(renderEdges({ edges: {}, lastRun: h2.mem.lastRun, now: night }), /No scans yet · <b>Paused/);
});

test("already-bet match ignores punctuation and case in names (Jr vs Jr.)", () => {
  const open = parseOpenBets([HEADER, betRow({ book: "DraftKings", odds: "-130", stake: "10", status: "pending", gameKey: "g1|player_rebounds|Wendell Carter Jr. Under|9.5" })]);
  const f = betFlags({ eventId: "g1", market: "player_rebounds", side: "Under", player: "Wendell Carter Jr", point: 9.5, bookKey: "draftkings", book: "DK" }, open);
  assert.deepEqual(f.map((x) => x.level), ["same"]);
  assert.match(f[0].text, /✓ You have \$10 on this \(DraftKings -130\)/);
  const t = parseOpenBets([HEADER, betRow({ book: "FanDuel", odds: "150", stake: "5", status: "pending", gameKey: "g1|h2h|ST. JOHN'S RED STORM|" })]);
  assert.equal(betFlags({ eventId: "g1", market: "h2h", side: "St. John's Red Storm", bookKey: "fanduel", book: "FD" }, t)[0].level, "same");
});

test("props status says how many games Pinnacle priced", async () => {
  const noPin = { ...propEvent(), bookmakers: propEvent().bookmakers.filter((b) => b.key !== "pinnacle") };
  const s = await harness({ PROP_SPORTS: "basketball_nba" }, [], noPin).run();
  assert.match(s.props.basketball_nba, /pulled props for 1 games \(Pinnacle priced 0\), 0 edges/);
});

test("short book names in alerts; pages keep full names", async () => {
  const { shortBook } = await import("../lib/scan.mjs");
  assert.deepEqual(["draftkings", "fanduel", "espnbet", "betrivers", "williamhill_us", "fanatics", "hardrockbet"].map((k) => shortBook({ bookKey: k })),
    ["DK", "FD", "TS", "BR", "CZR", "FAN", "HR"]);
  const g = game({ pin: [h2h(-110, -110)], books: { betrivers: [h2h(110, -130)] } });
  const h = harness({}, [g]);
  await h.run();
  assert.match(h.pushes[0].body.title, / @ BR$/);
  assert.match(h.pushes[0].body.message, /^Celtics ML \+110 @ BR\n/);
  const html = renderEdges({ edges: { nba: { at: NOW, hits: findEdges([g], "basketball_nba", { now: NOW }) } }, now: NOW });
  assert.match(html, /BetRivers · fair/);
});

test("edges older than 15 min are greyed; older than an hour fold away", () => {
  const base = findEdges([edgeGame()], "basketball_nba", { now: NOW })[0];
  const html = renderEdges({ edges: {
    a: { at: NOW - 5 * 60e3, hits: [{ ...base, key: "a", pick: "Fresh ML" }] },
    b: { at: NOW - 25 * 60e3, hits: [{ ...base, key: "b", pick: "Stale ML" }] },
    c: { at: NOW - 90 * 60e3, hits: [{ ...base, key: "c", pick: "Old ML" }] },
  }, now: NOW });
  const main = html.slice(0, html.indexOf('<details class="older">'));
  assert.match(main, /<li class="hot">\s*<div class="top"><span class="pick">Fresh ML/);
  assert.match(main, /<li class="hot stale">\s*<div class="top"><span class="pick">Stale ML/);
  assert.match(main, /seen 25m ago · <b>may be stale, check price<\/b>/);
  assert.doesNotMatch(main, /Old ML/);
  assert.match(html, /<summary>Older than 1 hour \(1\) · prices have likely moved<\/summary><ul><li class="hot stale">\s*<div class="top"><span class="pick">Old ML/);
  // only old edges -> main list says none, old ones still reachable
  const onlyOld = renderEdges({ edges: { c: { at: NOW - 90 * 60e3, hits: [base] } }, now: NOW });
  assert.match(onlyOld, /No open edges right now\.[\s\S]*Older than 1 hour \(1\)/);
});

test("closest misses: best EV per market below the thresholds, shown on the edges page", async () => {
  // ML at +1% EV (below 3%), spread at -4.5%, no totals; props best +2.4%
  const g = game({ pin: [h2h(-110, -110), spread(3, -110, -110)], books: { fanduel: [h2h(102, -130), spread(3, -110, -110)] } });
  const h = harness({ PROP_SPORTS: "basketball_nba", PROP_MIN_EV: "0.5" }, [g], propEvent());
  const s = await h.run();
  assert.equal(s.newHits.length, 0, "nothing clears the thresholds");
  const c = h.mem.closest.basketball_nba.best;
  assert.ok(Math.abs(c.h2h.ev - 0.01) < 1e-9);
  assert.equal(c.h2h.pick, "Celtics ML");
  assert.ok(c.spreads.ev < 0);
  assert.equal(c.totals, null);
  assert.ok(h.mem.closest["props:basketball_nba"].best.props.ev > 0.05);
  const html = renderEdges({ edges: h.mem.edges, closest: h.mem.closest, now: NOW });
  assert.match(html, /<div class="closest"><span class="cl">Closest this hour<\/span><span[^>]*><b>ML<\/b> <span class="pos">\+1\.0%<\/span> <small>Celtics ML \(FD\)<\/small><\/span><span[^>]*><b>Spread<\/b> <span class="neg">-4\.5%<\/span>/);
  assert.match(html, /<b>Props<\/b> <span class="pos">≥\+6\.0%<\/span>/);
  assert.doesNotMatch(html, /<b>Total<\/b>/);
  // stale (>2h) closest data is hidden
  assert.doesNotMatch(renderEdges({ edges: {}, closest: h.mem.closest, now: NOW + 3 * 3600e3 }), /Closest this hour/);
});

// --- better numbers: Pinnacle alt lines / ladder / model ---
import { probsAtBetterNumber, evOf, modelQ, candidatesFrom, refine, priceBetterNumbers, modelFallbackAllowed, crossed } from "../lib/alt.mjs";

const NFL = "americanfootball_nfl";
const bn = (extra = {}) => ({ // Knicks +3.5 -110 at FD vs Pin Knicks +3 -110/-110 (NFL)
  key: "g1|spreads|Knicks|3.5|fanduel", sel: "g1|spreads|Knicks", eventId: "g1", sportKey: NFL, sport: "NFL", market: "spreads",
  side: "Knicks", opp: "Celtics", point: 3.5, pinPoint: 3, p: 0.5, odds: -110, ev: 0.5 * dec(-110) - 1, betterLine: true,
  book: "FD", bookKey: "fanduel", pick: "Knicks +3.5", game: "Knicks @ Celtics", start: START, fair: -100, pinPrice: -110, ...extra,
});
const altMk = (outcomes, ageMin = 5) => ({ key: "alternate_spreads", last_update: new Date(NOW - ageMin * 60e3).toISOString(), outcomes });

test("better-number math: +3 -> +3.5 in the NFL buys the 3", () => {
  const pr = probsAtBetterNumber({ market: "spreads", side: "Knicks", pinPoint: 3, point: 3.5, p: 0.5, q: (k) => modelQ(NFL, "spreads", k) });
  assert.ok(Math.abs(pr.win - 0.54) < 1e-9 && pr.push === 0);
  assert.ok(Math.abs(evOf(pr, -110) - (0.54 * dec(-110) - 1)) < 1e-12); // about +3.1% vs the -4.5% floor
  // Over 41 -> 40.5 buys the 41; Under 44.5 -> 45 makes 45 a push
  const o = probsAtBetterNumber({ market: "totals", side: "Over", pinPoint: 41, point: 40.5, p: 0.5, q: (k) => modelQ(NFL, "totals", k) });
  assert.ok(Math.abs(o.win - (0.5 * (1 - 0.035) + 0.035)) < 1e-9);
  const u = probsAtBetterNumber({ market: "totals", side: "Under", pinPoint: 44.5, point: 45, p: 0.5, q: (k) => modelQ(NFL, "totals", k) });
  assert.ok(Math.abs(u.push - 0.02) < 1e-9 && Math.abs(u.win - 0.5) < 1e-9);
  assert.deepEqual(crossed("spreads", "Celtics", -3.5, -2.5), [-3]);
  assert.ok(modelFallbackAllowed(bn()));
  assert.ok(!modelFallbackAllowed(bn({ sportKey: "basketball_nba" })));
  assert.ok(!modelFallbackAllowed(bn({ point: 4.5, pinPoint: 4 })));
});

test("candidates: any better number within 1 pt with floor EV > -7% (or a model EV near the bar)", () => {
  const thr = () => 0.03;
  assert.equal(candidatesFrom([bn()], thr).length, 1, "the -4.5% floor example now qualifies");
  assert.equal(candidatesFrom([bn({ point: 4.5 })], thr).length, 0, "more than 1 pt away");
  assert.equal(candidatesFrom([bn({ odds: -125, ev: 0.5 * dec(-125) - 1 })], thr).length, 0, "floor -10% and model well short");
  assert.equal(candidatesFrom([bn({ betterLine: false })], thr).length, 0);
  assert.equal(candidatesFrom([bn({ market: "h2h" })], thr).length, 0);
});

test("refine: Pin alt at the exact number, ladder for missing numbers, CHECK on disagreement, stale alts ignored", () => {
  // exact: Pin Knicks +3.5 -125 / Celtics -3.5 +105
  const exact = altMk([{ name: "Knicks", point: 3.5, price: -125 }, { name: "Celtics", point: -3.5, price: 105 }]);
  let r = refine(bn(), { altMarket: exact, altFresh: true, opp: "Celtics" });
  const pAlt = (1 / dec(-125)) / (1 / dec(-125) + 1 / dec(105));
  assert.equal(r.fairSource, "Pin alt");
  assert.ok(Math.abs(r.ev - (pAlt * dec(-110) - 1)) < 1e-9);
  assert.equal(r.check, undefined, "alt within 3 pts of the model");
  assert.match(r.fairNote, /^Pin alt \+3\.5 -125$/);
  assert.match(formatHit(r), /fair -\d+ \(Pin alt \+3\.5 -125\) · EV \+\d/);
  assert.doesNotMatch(formatHit(r), /EV ≥/);
  // CHECK: Pin alt says +3.5 is a 62% shot, model ~54%
  const wild = altMk([{ name: "Knicks", point: 3.5, price: -175 }, { name: "Celtics", point: -3.5, price: 150 }]);
  r = refine(bn(), { altMarket: wild, altFresh: true, opp: "Celtics" });
  assert.equal(r.check, true);
  assert.match(r.fairNote, /CHECK: model says/);
  // ladder: book Knicks +4 vs Pin +3; no +4 alt, but 2.5/3.5/4.5 give landing chances on 3 and 4
  const ladder = altMk([
    { name: "Knicks", point: 2.5, price: 108 }, { name: "Celtics", point: -2.5, price: -118 },
    { name: "Knicks", point: 3.5, price: -128 }, { name: "Celtics", point: -3.5, price: 118 },
    { name: "Knicks", point: 4.5, price: -140 }, { name: "Celtics", point: -4.5, price: 128 },
  ]);
  r = refine(bn({ point: 4, pick: "Knicks +4" }), { altMarket: ladder, altFresh: true, opp: "Celtics" });
  assert.equal(r.fairSource, "Pin ladder");
  assert.match(r.fairNote, /lands on 3$/); // +4 wins on 3, pushes on 4
  assert.ok(r.ev > bn({ point: 4 }).ev, "better than the floor");
  // stale alt -> model fallback (NFL around 3) ; NBA -> floor kept (null)
  r = refine(bn(), { altMarket: exact, altFresh: false, opp: "Celtics" });
  assert.equal(r.fairSource, "model");
  assert.match(r.fairNote, /model: 3 lands ~8%/);
  assert.equal(refine(bn({ sportKey: "basketball_nba" }), { altMarket: null, altFresh: false, opp: "Celtics" }), null);
  // alts more than 1.5 pts from the main line are not trusted
  const far = altMk([{ name: "Knicks", point: 5, price: -150 }, { name: "Celtics", point: -5, price: 130 }]);
  assert.equal(refine(bn({ point: 5, pinPoint: 3, sportKey: "basketball_nba" }), { altMarket: far, altFresh: true, opp: "Celtics" }), null);
});

test("priceBetterNumbers: one alt call per game (all books share it), 15-min cache, daily credit cap", async () => {
  const mem = {};
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  const calls = [];
  const fetchAlt = async (q) => {
    calls.push(q);
    return { json: { bookmakers: [{ key: "pinnacle", markets: [altMk([{ name: "Knicks", point: 3.5, price: -125 }, { name: "Celtics", point: -3.5, price: 105 }])] }] }, headers: new Headers({ "x-requests-last": "1" }) };
  };
  const two = [bn(), bn({ key: "g1|spreads|Knicks|3.5|draftkings", bookKey: "draftkings", book: "DK", odds: -105, ev: 0.5 * dec(-105) - 1 })];
  let out = await priceBetterNumbers(two, { store, fetchAlt, now: NOW });
  assert.equal(calls.length, 1, "one call for the game");
  assert.deepEqual(calls[0], { sport: NFL, eventId: "g1", markets: "alternate_spreads" });
  assert.equal(out.refined.length, 2);
  assert.equal(out.stats.alt, 2);
  assert.equal(out.stats.creditsToday, 1);
  out = await priceBetterNumbers(two, { store, fetchAlt, now: NOW + 10 * 60e3 });
  assert.equal(calls.length, 1, "cached within 15 min");
  assert.equal(out.stats.cached, 1);
  out = await priceBetterNumbers(two, { store, fetchAlt, now: NOW + 16 * 60e3 });
  assert.equal(calls.length, 1, "game 2h out: cached 30 min");
  out = await priceBetterNumbers(two, { store, fetchAlt, now: NOW + 31 * 60e3 });
  assert.equal(calls.length, 2, "refetched after 30 min");
  // cap reached -> no fetch; NFL +3 -> +3.5 falls back to the model
  mem.altBudget.used = 100;
  out = await priceBetterNumbers([bn({ eventId: "g9", key: "g9|x", sel: "g9|x" })], { store, fetchAlt, now: NOW + 32 * 60e3, cap: 100 });
  assert.equal(calls.length, 2);
  assert.equal(out.stats.capped, 1);
  assert.equal(out.refined[0].fairSource, "model");
});

test("scan: better-number edge priced from Pin alt is alerted; a CHECK edge is shown but not alerted", async () => {
  // Pin Knicks +3 -110/-110 (floor for FD Knicks +3.5 -105 is -2.4%: no alert before this feature)
  const mk = () => ({ ...game({ pin: [spread(3, -110, -110)], books: { fanduel: [spread(3.5, -125, -105)] } }), sport_key: NFL });
  const run = async (altOutcomes) => {
    const h = harness({ SPORTS: NFL }, [mk()]);
    const inner = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (/bookmakers=pinnacle/.test(String(u)) && /alternate_spreads/.test(String(u))) {
        return new Response(JSON.stringify({ bookmakers: [{ key: "pinnacle", markets: [altMk(altOutcomes)] }] }), { headers: { "x-requests-last": "1" } });
      }
      return inner(u, o);
    };
    return { h, s: await h.run() };
  };
  let { h, s } = await run([{ name: "Knicks", point: 3.5, price: -135 }, { name: "Celtics", point: -3.5, price: 115 }]);
  assert.equal(s.altPricing.alt, 1);
  assert.equal(s.altPricing.creditsToday, 1);
  assert.equal(h.pushes.length, 1);
  assert.match(h.pushes[0].body.message, /Knicks \+3\.5 -105 @ FD\n  fair -\d+ \(Pin alt \+3\.5 -135\) · EV \+7\.\d% · Grade A/);
  assert.match(s.sports[NFL], /1 edges/);
  // Pin alt wildly off the model -> CHECK: on the edges page, not pushed
  ({ h, s } = await run([{ name: "Knicks", point: 3.5, price: -250 }, { name: "Celtics", point: -3.5, price: 200 }]));
  assert.equal(s.altPricing.check, 1);
  assert.equal(h.pushes.length, 0);
  assert.match(renderEdges({ edges: h.mem.edges, now: NOW }), /CHECK: Pin alt and model disagree/);
});

test("alt pricing details: only the needed market, failed/empty fetches spent + cached, ET-day counter, push base, CHECK shows both fairs", async () => {
  // push base: Pin +3 at 50% with a 9% chance of landing on 3 -> +3.5 wins 50% x 91% + 9% = 54.5% (not 59%)
  const pr = probsAtBetterNumber({ market: "spreads", side: "Knicks", pinPoint: 3, point: 3.5, p: 0.5, q: () => 0.09 });
  assert.ok(Math.abs(pr.win - 0.545) < 1e-12);
  // the cross-check uses that same number: Pin alt at 54.5% agrees with a 9% model, alt at 60% does not
  const at = (pct) => { const o = Math.round(-100 * pct / (1 - pct)); return altMk([{ name: "Knicks", point: 3.5, price: o }, { name: "Celtics", point: -3.5, price: -o }]); };
  const nfl9 = bn({ sportKey: NFL });
  const ok = refine(nfl9, { altMarket: at(0.54), altFresh: true, opp: "Celtics" });
  assert.equal(ok.check, undefined);
  assert.ok(Math.abs(ok.modelWin - 0.54) < 1e-9, "model (8% on 3) = 50% x 92% + 8%");

  const mem = {};
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  const calls = [];
  // totals-only candidate -> only alternate_totals requested
  const tot = bn({ key: "g2|t", sel: "g2|t", eventId: "g2", market: "totals", side: "Over", point: 40.5, pinPoint: 41, pick: "Over 40.5" });
  await priceBetterNumbers([tot], { store, now: NOW, fetchAlt: async (q) => { calls.push(q.markets); return { json: { bookmakers: [] }, headers: new Headers() }; } });
  assert.deepEqual(calls, ["alternate_totals"]);
  assert.equal(mem.altBudget.used, 1, "empty fetch counted as 1 credit");
  assert.equal(mem.altCache["g2|alternate_totals"].market, null, "'no alt lines' cached");
  // failed fetch: counted, cached, not retried next cycle
  const fail = bn({ key: "g3|x", sel: "g3|x", eventId: "g3" });
  const out = await priceBetterNumbers([fail], { store, now: NOW + 60e3, fetchAlt: async () => { calls.push("boom"); throw new Error("HTTP 500"); } });
  assert.equal(out.stats.failed, 1);
  assert.equal(mem.altBudget.used, 2);
  await priceBetterNumbers([fail], { store, now: NOW + 6 * 60e3, fetchAlt: async () => { calls.push("again"); throw new Error("x"); } });
  assert.ok(!calls.includes("again"), "not retried within 15 min");
  // counter resets at midnight ET (NOW is 3 PM ET; +10h = 1 AM ET next day)
  await priceBetterNumbers([bn({ key: "g4|x", sel: "g4|x", eventId: "g4" })], { store, now: NOW + 10 * 3600e3, fetchAlt: async () => ({ json: { bookmakers: [] }, headers: new Headers({ "x-requests-last": "1" }) }) });
  assert.equal(mem.altBudget.used, 1);
  assert.notEqual(mem.altBudget.day, "2026-11-04");

  // CHECK items show alt and model side by side, on the edges card and the check page
  const chk = refine(nfl9, { altMarket: at(0.62), altFresh: true, opp: "Celtics" });
  assert.equal(chk.check, true);
  const card = renderEdges({ edges: { a: { at: NOW, hits: [chk] } }, now: NOW });
  assert.match(card, /<div class="fairs"><span><b>Pin alt<\/b> fair -\d+ · EV \+\d+\.\d% · win 62\.0%<\/span><span><b>Model<\/b> fair -\d+ · EV \+\d\.\d% · win 54\.0%<\/span><\/div>/);
  const page = renderCheck({ then: { bookKey: "fanduel", odds: -110, sportKey: NFL, market: "spreads" }, result: { status: "ok", hit: chk }, now: NOW, book: "FD" });
  assert.match(page, /CHECK: Pin alt and model disagree\.<\/b><div class="fairs">/);
});

test("alt spending: only games within 4h, basketball floor trigger -5%, cache 60 min for far games", async () => {
  const thr = () => 0.03;
  const near = bn(); // START is 2h out
  assert.equal(candidatesFrom([near], thr, { now: NOW }).length, 1);
  assert.equal(candidatesFrom([bn({ start: new Date(NOW + 6 * 3600e3).toISOString() })], thr, { now: NOW }).length, 0, "6h out: skipped");
  assert.equal(candidatesFrom([bn({ start: new Date(NOW + 6 * 3600e3).toISOString() })], thr, { now: NOW, windowH: 8 }).length, 1);
  // basketball: floor -6% no longer qualifies (football still does at -6%)
  const floor6 = { odds: -125, ev: -0.06 };
  assert.equal(candidatesFrom([bn({ ...floor6, sportKey: "basketball_ncaab" })], thr, { now: NOW }).length, 0);
  assert.equal(candidatesFrom([bn({ ...floor6 })], thr, { now: NOW }).length, 1);
  assert.equal(candidatesFrom([bn({ odds: -110, ev: -0.045, sportKey: "basketball_nba" })], thr, { now: NOW }).length, 1, "-4.5% still qualifies");
  // far game (only reachable with a wider window) caches 60 min
  const mem = {};
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  const far = bn({ eventId: "gf", key: "gf|x", sel: "gf|x", start: new Date(NOW + 6 * 3600e3).toISOString() });
  let n = 0;
  const fetchAlt = async () => { n++; return { json: { bookmakers: [] }, headers: new Headers() }; };
  await priceBetterNumbers([far], { store, fetchAlt, now: NOW });
  await priceBetterNumbers([far], { store, fetchAlt, now: NOW + 30 * 60e3 });
  assert.equal(n, 1, "still cached at 30 min");
  await priceBetterNumbers([far], { store, fetchAlt, now: NOW + 61 * 60e3 });
  assert.equal(n, 2);
});

test("alt cache lifetime by time to tip: 15 min last hour, 30 min within 4h, 60 min beyond", async () => {
  const { altTtl } = await import("../lib/alt.mjs");
  assert.equal(altTtl(NOW + 45 * 60e3, NOW), 15 * 60e3);
  assert.equal(altTtl(NOW + 2 * 3600e3, NOW), 30 * 60e3);
  assert.equal(altTtl(NOW + 5 * 3600e3, NOW), 60 * 60e3);
  assert.equal(altTtl(NaN, NOW), 15 * 60e3);
});

test("check page: a priced better number never also says 'floor (no alt price)'; an unpriced one does", () => {
  const then = { bookKey: "fanduel", odds: -110, sportKey: NFL, market: "totals" };
  const priced = { ...bn({ market: "totals", side: "Under", point: 43.5, pinPoint: 43, pick: "Under 43.5" }), fairSource: "Pin alt", fairNote: "Pin alt 43.5 -128", ev: 0.037 };
  const a = renderCheck({ then, result: { status: "ok", hit: priced }, now: NOW, book: "FD" });
  assert.match(a, /Fair at this number: Pin alt 43\.5 -128/);
  assert.doesNotMatch(a, /no alt price available/);
  const floor = bn({ market: "totals", side: "Under", point: 43.5, pinPoint: 43, pick: "Under 43.5" });
  const b = renderCheck({ then, result: { status: "ok", hit: floor }, now: NOW, book: "FD" });
  assert.match(b, /EV shown is a floor \(no alt price available\)/);
  assert.doesNotMatch(b, /Fair at this number/);
});

// --- closing lines for CLV (read-only; served at /closing) ---
import { closeFor, captureCloses, clvPct, sportKeyOf } from "../lib/closing.mjs";

test("closeFor: Pinnacle no-vig at the bet's exact number (main, alt, prop), missing otherwise", () => {
  const pin = { key: "pinnacle", markets: [
    { key: "h2h", outcomes: [{ name: "Minnesota Golden Gophers", price: 263 }, { name: "Cincinnati Bearcats", price: -330 }] },
    { key: "spreads", outcomes: [{ name: "Knicks", price: -110, point: 3 }, { name: "Celtics", price: -110, point: -3 }] },
    { key: "alternate_spreads", outcomes: [{ name: "Knicks", price: -128, point: 3.5 }, { name: "Celtics", price: 108, point: -3.5 }] },
    { key: "totals", outcomes: [{ name: "Over", price: -105, point: 43 }, { name: "Under", price: -115, point: 43 }] },
    { key: "player_points", outcomes: [{ name: "Over", description: "Jayson Tatum", price: -120, point: 27.5 }, { name: "Under", description: "Jayson Tatum", price: 100, point: 27.5 }] },
  ] };
  const ml = closeFor({ market: "h2h", side: "Minnesota Golden Gophers" }, pin);
  const p = (1 / dec(263)) / (1 / dec(263) + 1 / dec(-330));
  assert.ok(Math.abs(ml.closeProb - p) < 1e-12);
  assert.equal(ml.source, "main");
  assert.equal(ml.pinPrice, 263);
  assert.equal(closeFor({ market: "spreads", side: "Knicks", point: 3 }, pin).source, "main");
  const alt = closeFor({ market: "spreads", side: "Knicks", point: 3.5 }, pin);
  assert.equal(alt.source, "alt");
  assert.equal(alt.pinPrice, -128);
  assert.match(closeFor({ market: "spreads", side: "Knicks", point: 4.5 }, pin).missing, /no price at your number/);
  assert.equal(closeFor({ market: "totals", side: "Under", point: 43 }, pin).pinPrice, -115);
  const pr = closeFor({ market: "player_points", side: "Jayson Tatum Over", player: "Jayson Tatum.", ou: "Over", point: 27.5 }, pin);
  assert.equal(pr.source, "prop");
  assert.match(closeFor({ market: "player_points", player: "Jayson Tatum", ou: "Over", point: 28.5 }, pin).missing, /no price/);
  assert.match(closeFor({ market: "h2h", side: "X" }, null).missing, /no Pinnacle/);
  assert.equal(clvPct(280, p), +((p * dec(280) - 1) * 100).toFixed(2));
  assert.equal(sportKeyOf("NCAAB"), "basketball_ncaab");
  assert.equal(sportKeyOf("nfl"), "americanfootball_nfl");
});

test("captureCloses: once per game in the last 10 min, alt market for spreads, CLV per bet, daily cap", async () => {
  const mem = {};
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  const start = NOW + 8 * 60e3;
  const open = parseOpenBets([HEADER,
    betRow({ id: "b1", sheetRow: "500", book: "theScore Bet", sport: "NCAAB", odds: "280", stake: "10", status: "pending", gameKey: "e1|h2h|Minnesota Golden Gophers|" }),
    betRow({ id: "b2", sheetRow: "501", book: "FanDuel", sport: "NCAAB", odds: "-110", stake: "10", status: "pending", gameKey: "e1|spreads|Minnesota Golden Gophers|7.5" }),
    betRow({ id: "b3", sheetRow: "502", book: "DraftKings", sport: "NBA", odds: "-110", stake: "10", status: "pending", gameKey: "e9|totals|Over|220.5" }), // starts in 3h
    betRow({ id: "b4", sheetRow: "503", book: "FanDuel", sport: "NCAAB", odds: "150", stake: "5", status: "pending", gameKey: "" }), // no key
  ]);
  const calls = [];
  const getEvents = async (sport) => sport === "basketball_ncaab"
    ? [{ id: "e1", commence_time: new Date(start).toISOString() }]
    : [{ id: "e9", commence_time: new Date(NOW + 3 * 3600e3).toISOString() }];
  const getPinnacle = async (q) => {
    calls.push(q);
    return { json: { bookmakers: [{ key: "pinnacle", markets: [
      { key: "h2h", outcomes: [{ name: "Minnesota Golden Gophers", price: 263 }, { name: "Cincinnati Bearcats", price: -330 }] },
      { key: "spreads", outcomes: [{ name: "Minnesota Golden Gophers", price: -110, point: 7 }, { name: "Cincinnati Bearcats", price: -110, point: -7 }] },
      { key: "alternate_spreads", outcomes: [{ name: "Minnesota Golden Gophers", price: -125, point: 7.5 }, { name: "Cincinnati Bearcats", price: 105, point: -7.5 }] },
    ] }] }, headers: new Headers({ "x-requests-last": "3" }) };
  };
  // 20 min before: nothing due
  let s = await captureCloses({ store, open, getEvents, getPinnacle, now: start - 20 * 60e3 });
  assert.equal(calls.length, 0);
  assert.equal(s.pendingWithKey, 3);
  // 8 min before: one call for the game, both bets recorded
  s = await captureCloses({ store, open, getEvents, getPinnacle, now: NOW });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sport: "basketball_ncaab", eventId: "e1", markets: "h2h,spreads,alternate_spreads" });
  assert.equal(s.captured, 2);
  assert.equal(s.credits, 3);
  const ml = mem.closing["e1|h2h|Minnesota Golden Gophers|"];
  assert.equal(ml.closeFair, toAmerican(ml.closeProb));
  assert.equal(ml.minutesBeforeStart, 8);
  assert.equal(ml.bets[0].sheetRow, "500");
  assert.ok(ml.bets[0].clvPct > 0, "+280 vs a ~+269 close is positive CLV");
  const sp = mem.closing["e1|spreads|Minnesota Golden Gophers|7.5"];
  assert.equal(sp.source, "alt");
  assert.equal(sp.pinPrice, -125);
  // not captured twice
  await captureCloses({ store, open, getEvents, getPinnacle, now: NOW + 4 * 60e3 });
  assert.equal(calls.length, 1);
  // cap: a fresh store with cap 2 can't afford a 3-market game
  const mem2 = {};
  const store2 = { get: async (k) => mem2[k] ?? null, setJSON: async (k, v) => { mem2[k] = structuredClone(v); } };
  await captureCloses({ store: store2, open, getEvents, getPinnacle, now: NOW, cap: 2 });
  assert.equal(calls.length, 1);
});

test("closing capture runs on every wake-up, even outside scan hours, reading the sheet only", async () => {
  const night = Date.parse("2026-11-04T05:00:00Z") + 23 * 3600e3; // 11 PM ET
  const url = "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=1&single=true&output=csv";
  const csv = [HEADER.join(","), betRow({ id: "b1", sheetRow: "500", book: "FanDuel", sport: "NBA", odds: "120", stake: "10", status: "pending", gameKey: "n1|h2h|Lakers|" }).join(",")].join("\n");
  const h = harness({ BET_TRACKER_CSV_URL: url }, []);
  const inner = globalThis.fetch;
  const sheetMethods = [];
  globalThis.fetch = async (u, o = {}) => {
    const s = String(u);
    if (s.startsWith("https://docs.google.com/")) { sheetMethods.push(o.method || "GET"); return new Response(csv); }
    if (/\/events\?/.test(s)) return new Response(JSON.stringify([{ id: "n1", commence_time: new Date(night + 6 * 60e3).toISOString() }]));
    if (/events\/n1\/odds/.test(s) && /bookmakers=pinnacle/.test(s)) {
      return new Response(JSON.stringify({ bookmakers: [{ key: "pinnacle", markets: [{ key: "h2h", outcomes: [{ name: "Lakers", price: 110 }, { name: "Suns", price: -130 }] }] }] }), { headers: { "x-requests-last": "1" } });
    }
    return inner(u, o);
  };
  const s = await h.run(night);
  assert.match(s.skipped, /outside scan hours/);
  assert.equal(h.mem.closing["n1|h2h|Lakers|"].pinPrice, 110);
  assert.equal(h.mem.lastRun.closing.captured, 1);
  assert.deepEqual([...new Set(sheetMethods)], ["GET"], "sheet only read");
});

test("closing CSV: one row per bet, header, missing rows blank closeFair/source, quoted cells; never pruned", async () => {
  const { closesToCsv } = await import("../lib/closing.mjs");
  const closes = [
    { gameKey: "e2|spreads|Team, Inc|7.5", capturedAt: "2026-11-10T23:52:00.000Z", missing: "Pinnacle has no price at your number", bets: [{ id: "b9", sheetRow: "510", clvPct: null }] },
    { gameKey: "e1|h2h|Minnesota Golden Gophers|", capturedAt: "2026-11-10T23:50:00.000Z", closeFair: 269, source: "main",
      bets: [{ id: "b1", sheetRow: "500", clvPct: 3.01 }, { id: "b2", sheetRow: "501", clvPct: -1.5 }] },
  ];
  assert.equal(closesToCsv(closes),
    "id,sheetRow,gameKey,closeFair,clvPct,source,missing,capturedAt\n" +
    "b1,500,e1|h2h|Minnesota Golden Gophers|,269,3.01,main,,2026-11-10T23:50:00.000Z\n" +
    "b2,501,e1|h2h|Minnesota Golden Gophers|,269,-1.5,main,,2026-11-10T23:50:00.000Z\n" +
    'b9,510,"e2|spreads|Team, Inc|7.5",,,,Pinnacle has no price at your number,2026-11-10T23:52:00.000Z\n');
  assert.equal(closesToCsv([]), "id,sheetRow,gameKey,closeFair,clvPct,source,missing,capturedAt\n");
  // a capture from months ago survives a new pass
  const mem = { closing: { old: { gameKey: "old", start: "2026-09-01T00:00:00.000Z", capturedAt: "2026-09-01T00:00:00.000Z", captured: true, bets: [] } } };
  const store = { get: async (k) => mem[k] ?? null, setJSON: async (k, v) => { mem[k] = structuredClone(v); } };
  await captureCloses({ store, open: [], getEvents: async () => [], getPinnacle: async () => ({}), now: NOW });
  assert.ok(mem.closing.old, "kept for the season");
});

test("moneyline confirmation: alert only when the edge holds across two pulls; spreads/props alert at once", async () => {
  const g = game({ pin: [h2h(-110, -110), spread(3, -110, -110)], books: { fanduel: [h2h(110, -130), spread(3, -130, 108)] } });
  const games = [g];
  const h = harness({ CONFIRM_ML: "1" }, games);
  let s = await h.run();
  assert.deepEqual(s.newHits.map((x) => x.market), ["spreads"], "spread alerts immediately, ML waits");
  assert.equal(s.awaitingConfirm, 1);
  assert.match(renderEdges({ edges: h.mem.edges, now: NOW }), /Waiting for the next scan to confirm/);
  // a second pull seconds later (Scan now twice) doesn't count
  s = await h.run(NOW + 60e3, true);
  assert.equal(s.newHits.length, 0);
  // next scheduled pull, edge still there -> ML alerts
  s = await h.run(NOW + 15 * 60e3);
  assert.deepEqual(s.newHits.map((x) => x.pick), ["Celtics ML"]);
  assert.equal(s.awaitingConfirm, undefined);
  assert.equal(h.pushes.length, 2);

  // an edge that vanishes for a pull starts over
  const h2 = harness({ CONFIRM_ML: "1", NEAR_INTERVAL_MIN: "5" }, games);
  await h2.run();
  const saved = g.bookmakers[1].markets;
  g.bookmakers[1].markets = [h2h(-105, -115)];
  await h2.run(NOW + 6 * 60e3);
  g.bookmakers[1].markets = saved;
  s = await h2.run(NOW + 12 * 60e3);
  assert.ok(!s.newHits.some((x) => x.market === "h2h"), "seen again after a gap: waits once more");
  s = await h2.run(NOW + 18 * 60e3);
  assert.ok(s.newHits.some((x) => x.market === "h2h"));

  // default is ON; settings toggle round-trips
  assert.equal(currentSettings(() => undefined).confirmMl, true);
  assert.equal(parseSettingsForm(new URLSearchParams({ confirm_ml: "on" })).CONFIRM_ML, "1");
  assert.match(renderSettings({ cur: currentSettings(() => undefined), token: "t" }), /name="confirm_ml" checked/);
});
