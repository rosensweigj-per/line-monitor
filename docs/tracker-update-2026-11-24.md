# Line Monitor update for the Bet Tracker (2026-11-24)

Follows the 11/22 update (lean closes, injury lines). All live on the site as of 11/24. The monitor still only reads the sheet and never writes to it, and never places bets.

## 1. SGP builder: `/sgp` (new)
- **What:** find an NFL or NBA game, pick a book, a profit boost (default 30%) and 2–6 legs. About 7 Odds API credits per game, cached 5 minutes. Opened from the **SGP** button on the Best $ page.
- **Legs:** moneyline, spread, total; NBA points, rebounds, assists, threes; NFL passing, rushing and receiving yards and receptions. **No anytime TD**: books post only the Yes side, so there's no fair price.
- **Leg EV:** each leg shows that book's price and its EV against the **consensus no-vig price of the other books** at that exact number (Pinnacle counted twice; books Jason doesn't bet still count).
- **The key output:** "Worth it if FD shows **+536** or better before the boost." The Odds API has no SGP prices, so the page gives the **break-even pre-boost SGP price**. Jason can type the book's actual SGP price to see the boosted price and EV.
- **Assumption:** the fair parlay price multiplies the legs' chances, i.e. treats them as unrelated.
  - Legs that go together (a team wins + its QB/stars go over) make the real fair price better than shown (safe side).
  - Legs that work against each other make it worse. The page warns on: both teams' sides, Over and Under on the same line, and a game total with a player prop going the other way.
- **Expectation:** books build in a big margin on SGPs (often 20–30%+ on 3+ legs), so most 20–30% SGP boosts will come out short of break-even. The +EV ones are usually 2–3 legs built from legs showing about 0% or better at that book, with bigger boosts.
- **Logging suggestion:** log a boosted SGP like any boost bet, with the note "SGP builder: break-even +X, took +Y" so we can later check whether SGPs that cleared break-even actually paid.

## 2. Boost calculator on Best $
- Buttons for None / 10 / 20 / 25 / 30 / 50 / 100% profit boost. Every book's price shows its boosted odds (e.g. −110 → +114 at 25%) and the boosted EV against Pinnacle's no-vig fair price.
- **"Best use of a X% boost"** names the single best book and side for that game, or says "(not worth it here)".
- Computed on the phone, so no extra credits. Profit boosts only (not odds boosts or max-bet limits).
- Formula: boosted decimal = 1 + (decimal − 1) × (1 + boost); EV = fair chance × boosted decimal − 1.

## 3. Edges page
- **Refresh** button (reloads, no scan, no credits) next to Scan now.
- The page reloads itself when the home-screen app is reopened after 30+ seconds, so new alerts show without a rescan.
- **Recent alerts** moved right under the open edges. Alerts stay listed with a Check price button until the game starts, even after Pushover deletes the notification (10 min).

## 4. Paper test: early read (11/18–11/23, rules v2)
Counting a pick offered at several books as one bet:

| | Consensus method | Pinnacle method |
|---|---|---|
| Main lines: record | 24–29, −2.6 units | 35–22, +16 units |
| Main lines: CLV | **+6.0%** vs consensus close; +5.6% vs Pinnacle close (beat it 45 of 60) | **0.0%** (coin flip) |
| Props: CLV | **+3.5%** (beat the close 105 of 122); +3.1% vs Pinnacle close | +1.5% vs Pinnacle close, −0.2% vs consensus |

- The Pinnacle method's +16 units is almost certainly luck: its picks don't beat the close, so they have no expected profit. +16 units over 57 bets is about 2 standard deviations.
- Consensus picks beat even Pinnacle's own closing line. That's the strongest signal so far. Their losing record over 53 bets is normal variance.
- **Interim rule (unchanged):** on alerts, ✓ Consensus agrees → bet if still +EV; ✗ disagrees → pass.
- The Dec 2 review is still planned. If this holds, the recommendation will be to switch alerts to the consensus method.

## 5. Staking (unchanged until Dec 2)
- **Alert bets:** flat **$5**, only on ✓ consensus-agree alerts. If consensus picks are still beating the close by about +3% on Dec 2 with a few hundred more entries, step up to about $10 (about 1% of bankroll). If the edge disappears, stop.
- **Boost bets** that the calculator or SGP builder shows as clearly +EV: the edge comes from the boost, so size within the boost's limit.
- **Leans:** own test. After about 50 leans with closes, if the average CLV is above +2%, size up.

Full details: `docs/how-edges-work.md` sections 12 (injuries) and 13 (SGP builder) in the repo.
