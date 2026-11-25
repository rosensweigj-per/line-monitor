# Line Monitor — how edges are identified

_Last updated 11/18/2026. Settings marked "current" are editable in the app's Settings page; values here are as of
this date._

Alerts-only system (Netlify scheduled function + The Odds API). It never places bets or touches money.
It reads the Bet Tracker sheet's Pending tab (published CSV) only to tag alerts; it never writes to the sheet.

## 1. Data
- Odds source: The Odds API (100K credits/month since 11/18; was 20K). Monitor pauses below 3,000 remaining.
- Sharp reference: Pinnacle.
- Books (current): ON DraftKings, FanDuel, theScore, Caesars, Hard Rock; OFF BetRivers, Fanatics, BetMGM.
  (All are still pulled and used for the consensus price in the paper test.)
- Sports: NFL, NCAAF, NBA, NCAAB, NHL (MLB optional). Games starting within 36h, pre-game only.
- Markets: moneyline (h2h), spreads, totals; player props (over/unders):
  - NBA: points, rebounds, assists
  - NFL: passing yds, passing TDs, completions, rushing yds, receptions, receiving yds, rush+rec yds

## 2. Fair price and EV
- Remove the vig from Pinnacle's two-way market (`fairProb` in lib/scan.mjs):
  - Spreads, totals, props: multiplicative. fair p = implied(side) / (implied(side) + implied(other side)).
  - Moneylines: power method. Solve k so implied(side)^k + implied(other)^k = 1; fair p = implied(side)^k.
    It takes more vig off the underdog than the favorite, so longshot dogs stop looking +EV by default
    (Pin +225 / −265: fair +248, not +236). Near even money it matches multiplicative. Added 11/11 after the
    alert-bet review: 8 of 11 moneyline bets at +200 or longer fell under 3% EV once re-priced this way.
    The closing-line capture (section 9) and Best price page use the same method, so CLV stays comparable.
- EV at a book = p × decimal odds − 1.
- Filters: odds −300 to the longest-odds cap (`MAX_ODDS`, default +300, currently +250, set in Settings → Alerts; applies to main
  lines and props); Pinnacle price < 45 min old; no Virginia college teams; best book per selection only.
- Extra EV by sport (`EV_BUMP_<sport key>`, Settings → Alerts, default 0; currently NCAAB +2%, NCAAF +2%): added to every threshold for that sport,
  e.g. +2% on NCAAB makes a 5% moneyline threshold 7% there. Added 11/11 after college alerts showed weak CLV
  (NCAAB +2.7%, NCAAF +0.3%, vs NBA +6.2%) and bets at +200 or longer beat the close only 6 of 13 times.
- Alert thresholds (current): moneyline 4%, spreads 4%, totals 4%, props 5%.
- Moneyline confirmation (`CONFIRM_ML`, on by default; Settings → Alerts): a moneyline edge alerts only after it shows
  up in two pulls in a row for its sport, at least 4 minutes apart. Until then it's on the edges page marked
  "Waiting for the next scan to confirm". If the edge disappears for a pull, it starts over. Added 11/11 after
  moneyline alerts showed +6% EV at alert but only +2% CLV (beat the close 9 of 17). Spreads, totals and props alert at once.
- Several books at once (`tagCrowd`, main lines only): if two or more of my books clear the threshold on the same
  side of a game (moneyline and spread count as one side; totals by Over/Under), the alert and the edges page add
  "VERIFY: also +EV at HR, BR — books may be moving on news, Pinnacle may be stale". If Pinnacle's own price for that
  pick changed since the monitor's previous pull, the note instead reads "Also +EV at HR, BR — Pinnacle moved since
  the last scan, books may be lagging" (Pinnacle leading is the usual real edge). Direction and size count
  (`pinMove`): only a move TOWARD the pick of at least half a point of win chance (or a number change in its favor)
  gets the softer note. Pinnacle moving toward the books' longer price reads "VERIFY: ... Pinnacle is moving toward
  the books' price, edge may be closing". A one-cent tick, a first sighting, or a previous pull more than 20 minutes
  old all get the standard VERIFY. Nothing is suppressed and the
  stake is unchanged. Added 11/11: in the alert-bet record, main-line bets where 2+ books beat fair went 1–9 with
  −0.4% CLV, against +3.0% CLV when only one book was out of line (FAMU +8.5 on 11/11: Pinnacle moved a full point
  toward UMKC within the hour). Props are not tagged (books rarely agree there, and prop CLV is good).

## 3. Better numbers (book has a better spread/total number than Pinnacle, e.g. +3.5 vs Pin +3)
- Worse numbers are never compared.
- Base EV uses Pinnacle's probability at its own number. That understates the edge, so it is shown as a floor: "EV ≥ x%".
- Re-pricing (lib/alt.mjs), for better numbers within 1 point of Pinnacle's main line, games within 4h of start,
  floor EV > −7% (−5% basketball) or a key-number estimate near the threshold:
  1. Pinnacle's alternate line at the book's exact number, vig removed ("Pin alt"). One alternate-lines call per
     game (spreads or totals only as needed), cached 15 min in the last hour / 30 min within 4h, shared by all books.
  2. Else landing chances derived from Pinnacle's alt ladder, from the price gap between k−0.5 and k+0.5 ("Pin ladder").
  3. Else a conservative key-number model, only for NFL/NCAAF spreads crossing 3 or 7 ("model").
     Push base: win = p × (1 − push) + push, e.g. 50% × 91% + 9% = 54.5%.
  4. Else keep the floor.
- Safeguards: alt prices only within 1.5 pts of the main line and < 45 min old. If the alt and model win
  probabilities differ by > 3 points, the edge is marked CHECK: shown in the app with both fair prices, never alerted.
  Alt fetches capped at 100 credits/day (resets midnight ET; failed or empty fetches count and are cached).

## 4. Props
- Same no-vig method per player line (Over/Under pairs from Pinnacle). A lower Over or higher Under than
  Pinnacle's counts as a better number (floor EV).
- Checked every 30 min per game, starting 4h before tip (current). NBA: points, rebounds, assists, threes;
  NFL: all seven prop types. /status reports how many games Pinnacle actually priced.

## 5. Schedule (current)
- Scans 9 AM–10 PM ET. Each sport: every 5 min within 1h of a game, 10 min within 4h, else every 30 min
  (current, set 11/18 with the 100K plan). Better-number checks capped at 300 credits/day.
- "Scan now" in the app ignores hours and intervals.

## 6. Stake and grade (by EV; better-number floors size off the floor)
- Base stake: 3–4.9% $10 · 5–7.9% $15 · 8–11.9% $25 · 12%+ $30 cap + "VERIFY: stale Pinnacle / injury?"
  (below 3%, only if a threshold is lowered: $5).
- Then: odds +200 or longer → halve; NCAAF spreads → max $10; round to nearest $5, minimum $5.
- Grade: 8%+ A+ · 6–7.9% A · 4–5.9% B · 3–3.9% C · <3% D.

## 7. Alerts (Pushover)
- One alert per edge (top 5 per scan; the rest in one "+N more" summary). Alerts auto-expire after 10 min.
- Format: "Kentucky ML +200 @ BR / fair +187 (Pin +178) · EV +4.6% · Grade B · stake $5 / NCAAB · game · time".
  Short book names: DK, FD, TS (theScore), BR, CZR, FAN, HR, MGM.
- Each alert links to a Check price page that re-prices that one bet live (~1 credit): price, fair price, EV and
  stake, alert vs now, with a verdict: Still +EV / Thin / Gone.
- Re-alerts only when the price improves or after 6h.

## 7a. App pages (all need ?token=)
- `/edges`: open edges (greyed after 15 min, folded away after an hour), Recent alerts until game start, Scan now.
  The status line shows the last scan, the next scan ("Next scan in 11m (NBA)", or the start time when paused) and
  credits left. A "Today" line counts the day's scans (ET), distinct edges found and alerts sent, and the best
  EV seen per market even below the thresholds (kept 14 days; also in /status as `today`). "Closest this hour" shows the best EV per market even below the thresholds; tap it to expand full
  rows with the pick, book, fair price, game and a Check price link.
- `/check`: live re-price of one bet. `/best`: every book's price for a team. `/settings`: all the settings above.

## 8. "Already bet" tags (from the tracker's Pending tab)
- Match key (column T gameKey): oddsApiEventId|market|side|point
  - side = team name (h2h/spreads), Over/Under (totals), "Player Name Over|Under" (props); point blank for ML.
  - Names match ignoring punctuation and case ("Wendell Carter Jr" = "Wendell Carter Jr.").
- Tags (never suppress the alert):
  - ✓ same side already bet ("You have $X on this (BOOK +odds)")
  - ⚠ other side at another book (possible hedge/middle)
  - ⛔ other side at the SAME book (never opposite sides at one book)
  - ℹ same game, other market or player
- Bonus-funded bets are labeled; the sheet is cached about 2 min plus Google's publish delay.

## 8a. Team notes (from the tracker's Notes tab, read-only)
- Tab "Notes" with columns team, sport, note, until (YYYY-MM-DD, optional), added; published to the web as CSV and
  set in Netlify as `BET_TRACKER_NOTES_URL` (either the pubhtml or the CSV link works). Cached 5 minutes.
- A note shows when its team (full name, ignoring punctuation/case) is either team in the alert's game, in the same
  sport, and `until` hasn't passed: "📝 Duke Blue Devils: …" on alerts, edge cards, Recent alerts and the check page.
- Information only: never changes EV, stake or grade. A broken link never blocks alerts (/status shows notes.error).

## 9. Closing lines for CLV (read-only)
- Every 5-minute wake-up (even outside scan hours; never below the 3,000-credit floor), the monitor reads open bets
  with a gameKey from the Pending tab. For any game starting within 10 minutes it pulls Pinnacle once (bet markets,
  plus alternate spreads/totals) and records the no-vig closing price at each bet's exact number.
- Served at `GET /closing?token=…` (optional `&since=ISO`, `&keys=gameKey1,gameKey2`) as JSON, or with `&format=csv`
  as one row per bet: `id,sheetRow,gameKey,closeFair,clvPct,source,missing,capturedAt` (header included, oldest first). The tracker fetches it
  and writes closeFair / clvPct itself. The monitor never writes to the sheet.
- Each record: gameKey, sport, eventId, market, side, point, start, capturedAt, minutesBeforeStart,
  closeFair (American, no-vig), closeProb, pinPrice, pinPoint, source (main | alt | prop) — or `missing` with a reason
  (e.g. Pinnacle has no price at your number) — and bets: [{ id, sheetRow, book, odds, stake, clvPct }].
- clvPct = (closeProb × decimal odds of the bet − 1) × 100. "Close" = Pinnacle's price 5–10 min before start.
- Bets without a gameKey get no close. Capped at 60 credits/day (`CLOSE_DAILY_CAP`), typically 1–3 per game.
- Kept for the whole season, append-only: a captured game is never changed or deleted.
- **Leans (since 11/22):** the monitor also reads the Leans tab (published as CSV, `BET_TRACKER_LEANS_URL`) and
  captures a close for every lean with a gameKey (column R), bet or not, the same way. A lean whose gameKey is
  also an open bet gets no extra row (the Leans tab looks the close up by gameKey). Lean rows in the CSV: `id` = the
  lean id, `sheetRow` = the Leans row, `source` = `lean`, `clvPct` blank (the sheet computes it from the unboosted
  price). Team totals are pulled too (`team_totals` + `alternate_team_totals`); if Pinnacle doesn't post one the row
  says `missing`. Capture only: leans never alert.

## 10. Paper test: Pinnacle method vs consensus method (started 11/18)
- Why: through 11/17, alert bets were 35-62 (−$224) despite +4.9% average CLV vs Pinnacle. Props looked best on
  CLV but lost money, which suggests Pinnacle's prop prices (low limits) are too soft to anchor on.
- Consensus method (lib/consensus.mjs): fair chance = no-vig average of every OTHER bookmaker in the pull at the exact
  same number (my books, BetMGM, Pinnacle counted twice); the priced book is left out. Needs 3+ other books. Edge =
  price beats consensus by `CONS_MIN_EV` (3%). Same odds window and book on/off rules. Main lines and props.
- Shadow log (lib/shadow.mjs, blob "shadow", 60 days): every edge either method finds is logged once at the first
  price seen. ~10 min before start, one all-books pull per game records the consensus close and the Pinnacle close.
  Main lines are settled from final scores (Odds API scores, daysFrom=3, every 3h). Props can't be settled
  automatically (no stats feed), so they're judged on CLV. Flat 1 unit per edge.
- Same rules for both methods (rules v2, from the 11/18 fix): flat 3% (`CONS_MIN_EV`), same odds window, every
  enabled book, no two-scan moneyline confirmation, no sport extras; better numbers at their floor EV. The Pinnacle
  side is logged from the all-books pull, independent of the real alert settings. Every edge, whichever method
  found it, is scored against BOTH the consensus close and the Pinnacle close. Rows logged before the fix are kept
  but left out of the comparison (`/shadow?…&all=1` shows them).
- Never alerts or changes stakes. Own credit cap `SHADOW_DAILY_CAP` (400/day). `SHADOW=0` turns it off.
- Results: `/shadow?token=…` (table per method: edges, avg EV, CLV vs each close and beat counts, record, units,
  ROI; latest edges), `&format=csv` or `&format=json`, `&since=YYYY-MM-DD`.

- Consensus check on live alerts (from 11/19, information only; alerts still use Pinnacle pricing): every alert,
  edge card, Recent alert and Check price page shows how the consensus prices the same bet at the same number:
  "✓ Consensus agrees: +x%" (>= 3%), "~ Consensus: only +x%" (0–3%), "✗ Consensus disagrees: −x% — Pinnacle may be
  off", or "too few books at this number". Early paper-test data (11/18): consensus-flagged edges beat the closing
  prices far more often than Pinnacle-only ones, so favor alerts where the consensus agrees.

## 11. Monitor fields useful for matching
sport, game ("Away @ Home"), start (ISO), market, pick, book, bookKey, odds, point, pinPoint, betterLine,
fair (American, no-vig), pinPrice, ev, fairSource (Pin alt / Pin ladder / model), check (bool), eventId (Odds API).

## 12. Injury status changes (info only, since 11/22)
- Source: ESPN's free injuries feed (NFL, NBA, NHL, MLB; no college: ESPN has no usable college data). Polled on scan
  runs for leagues with a game in the next 6 hours, at most every 5 minutes. No Odds API credits.
- Each poll is compared with the last snapshot: newly listed, status changed, or dropped off the report ("off report").
  A rolling 24-hour change log is kept. The first poll of a league is a baseline (nothing logged).
- Alerts, edge cards and the check page get one `🩹` line: up to 3 changes for either team in the last 12 hours, key
  positions first (NFL QB/RB/WR/TE, NHL G, MLB SP; every NBA player counts). Player props show that player's own status
  first, then same-team same-position changes.
- If a key-position change for either team happened in the last 60 minutes, the alert title starts with
  `⚠️ news Nm` and the alert says to check the consensus line. Reason: if the book moved on the news before Pinnacle
  did, Pinnacle's fair price is stale and the "edge" can be on the wrong side; the consensus line shows ✗ when the
  other books have moved too.
- Never changes EV, stake or grade. ESPN posts changes minutes after the news, so this explains lines more than it
  beats them. Turn off with `INJURIES=0`. Debug: `/status?token=…&injuries=1`.

## 13. SGP builder (`/sgp`, since 11/24; information only)
- Find an NFL or NBA game, pick a book, a profit boost and 2–6 legs (moneyline, spread, total; NBA points/rebounds/
  assists/threes; NFL passing/rushing/receiving yards and receptions). About 7 credits per game. Odds are pulled when
  a game is opened and reused for 2 minutes; the page shows "odds pulled N min ago" (orange after 5 min) and a
  "Refresh odds" button that always pulls fresh and keeps the book, boost and picked legs.
- "Alt lines" switch (off by default; about 16 credits per game instead of 7): adds alt spreads, alt totals and alt
  player props. Alt numbers are listed under their main market (tagged "alt") and priced against every other book that
  has that number, main or alt. Alt props that books post only on the Over side have no fair price and can't be used.
- Each leg shows that book's price and its EV against the consensus no-vig price of the other books at that exact
  number (Pinnacle counted twice; books you don't bet still count toward the fair price).
- Leg filter (since 11/25): show legs with EV at least All / −5% / −3% (default) / 0% / +2%. With a filter on, props
  are one list, best EV first. Picked legs always stay visible. `&f=all` or `&f=0` in the link.
- Sort: Best EV (default; every leg, main lines and props, in one list best first) or By market (sections, props
  grouped by player). `&o=group` in the link.
- "Need 3+ books" (on by default): legs whose fair price comes from fewer than 3 other books are tagged "fair from N
  book(s) only" and hidden from filtered lists and suggestions; turn it off to see them.
- Suggested SGPs: the best 2-leg and 3-leg combos at the chosen book (top 2 of each), from the 12 best legs, skipping
  legs that clash (two moneyline/spread legs, two legs from the same line, a game total with a player prop the other way).
  Ranked by the legs' combined EV at the book's own prices; each shows the fair price and the break-even SGP price with
  the boost. "Use" loads it into the slip.
- The Odds API has no SGP prices, so the page gives the fair parlay price (leg chances multiplied, i.e. legs treated as
  unrelated) and the lowest pre-boost SGP price that is +EV with the chosen boost. Type the book's SGP price to see the
  boosted price and EV.
- Legs that go together (a team wins + its QB/stars go over) make the real fair price better than shown (safe side).
  Legs that work against each other make it worse; the page warns on both-teams sides, Over and Under on the same line,
  and a game total paired with a player prop the other way. Anytime TD isn't included (books post only the Yes side,
  so there's no fair price).
