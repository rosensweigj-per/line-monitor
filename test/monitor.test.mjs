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
  form.set("props", "on");
  form.set("prop_player_points", "on");
  form.set("prop_player_rebounds", "on");
  form.set("min_ev", "2.5");
  form.set("prop_min_ev", "5");
  form.set("start", "10");
  form.set("end", "23");
  const saved = parseSettingsForm(form);
  assert.deepEqual(saved, {
    BOOKS_OFF: "fanatics",
    SPORTS: "basketball_nba,icehockey_nhl",
    PROP_SPORTS: "basketball_nba",
    PROP_MARKETS: "player_points,player_rebounds",
    MIN_EV: "0.025",
    PROP_MIN_EV: "0.05",
    ACTIVE_START_HOUR_ET: "10",
    ACTIVE_END_HOUR_ET: "23",
  });

  const cur = currentSettings(withSettings((k) => ({ MIN_EV: "0.03", BOOKS_OFF: "dk" })[k], saved));
  assert.equal(cur.minEv, 0.025);
  assert.deepEqual([...cur.booksOff], ["fanatics"]);
  const html = renderSettings({ cur, token: "t", custom: true });
  assert.match(html, /name="book_fanatics">/);
  assert.match(html, /name="book_draftkings" checked/);
  assert.match(html, /name="min_ev"[^>]*value="2.5"/);
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
  const s = parseSettingsForm(new URLSearchParams({ min_ev: "abc", prop_min_ev: "-4", start: "20", end: "8" }));
  assert.equal(s.MIN_EV, "0.03");
  assert.equal(s.PROP_MIN_EV, "0");
  assert.equal(s.ACTIVE_END_HOUR_ET, "21");
  assert.equal(s.SPORTS, "off");
  assert.equal(s.PROP_SPORTS, "off");
  assert.equal(s.BOOKS_OFF, "draftkings,fanduel,espnbet,betrivers,williamhill_us,fanatics,hardrockbet");
});
