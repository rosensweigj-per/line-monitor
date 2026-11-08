# Line Monitor — how edges are identified

_Last updated 11/8/2026. Settings marked "current" are editable in the app's Settings page; values here are as of
this date._

Alerts-only system (Netlify scheduled function + The Odds API). It never places bets or touches money.
It reads the Bet Tracker sheet's Pending tab (published CSV) only to tag alerts; it never writes to the sheet.

## 1. Data
- Odds source: The Odds API (20K credits/month). Monitor pauses below 3,000 remaining.
- Sharp reference: Pinnacle. BetMGM is pulled for reference only (no account).
- Books scanned (current): DraftKings, FanDuel, theScore, BetRivers, Caesars, Hard Rock. Fanatics is OFF.
- Sports: NFL, NCAAF, NBA, NCAAB, NHL (MLB optional). Games starting within 36h, pre-game only.
- Markets: moneyline (h2h), spreads, totals; player props (over/unders):
  - NBA: points, rebounds, assists
  - NFL: passing yds, passing TDs, completions, rushing yds, receptions, receiving yds, rush+rec yds

## 2. Fair price and EV
- Remove the vig from Pinnacle's two-way market (multiplicative):
  fair p = implied(side) / (implied(side) + implied(other side)).
- EV at a book = p × decimal odds − 1.
- Filters: odds −300 to +300; Pinnacle price < 45 min old; no Virginia college teams; best book per selection only.
- Alert thresholds (current): moneyline 4%, spreads 3%, totals 3%, props 7%.

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
- Checked hourly per game, starting 6h before tip. /status reports how many games Pinnacle actually priced.

## 5. Schedule (current)
- Scans 9 AM–6 PM ET. Each sport: every 15 min within 4h of a game (5-min option in the last hour), else hourly.
- "Scan now" in the app ignores hours and intervals.

## 6. Stake and grade (by EV; better-number floors size off the floor)
- Base stake: 3–4.9% $10 · 5–7.9% $15 · 8–11.9% $25 · 12%+ $30 cap + "VERIFY: stale Pinnacle / injury?"
  (below 3%, only if a threshold is lowered: $5).
- Then: odds +200 or longer → halve; NCAAF spreads → max $10; round to nearest $5, minimum $5.
- Grade: 8%+ A+ · 6–7.9% A · 4–5.9% B · 3–3.9% C · <3% D.

## 7. Alerts (Pushover)
- One alert per edge (top 5 per scan; the rest in one "+N more" summary). Alerts auto-expire after 10 min.
- Format: "Kentucky ML +200 @ BR / fair +187 (Pin +178) · EV +4.6% · Grade B · stake $5 / NCAAB · game · time".
  Short book names: DK, FD, TS (theScore), BR, CZR, FAN, HR.
- Each alert links to a Check price page that re-prices that one bet live (~1 credit): price, fair price, EV and
  stake, alert vs now, with a verdict: Still +EV / Thin / Gone.
- Re-alerts only when the price improves or after 6h.

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

## 9. Monitor fields useful for matching
sport, game ("Away @ Home"), start (ISO), market, pick, book, bookKey, odds, point, pinPoint, betterLine,
fair (American, no-vig), pinPrice, ev, fairSource (Pin alt / Pin ladder / model), check (bool), eventId (Odds API).
