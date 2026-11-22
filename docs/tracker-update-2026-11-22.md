# Line Monitor update for the Bet Tracker (2026-11-22)

Two changes went live on 11/22. The monitor still only reads the sheet and never writes to it.

## 1. Closing lines for leans (live since about 10:35 AM ET)
- The monitor reads the **Leans** tab (published as CSV, env var `BET_TRACKER_LEANS_URL`) on every 5-minute run. The first run found 16 leans with a gameKey.
- Every lean with a **gameKey in column R** gets a Pinnacle closing price, whether it was bet or not. Same method as open bets: captured once, in the last 10 minutes before start; power devig for moneylines, multiplicative for everything else; Pinnacle's alternate line if its main number has moved.
- **One close per gameKey.** A lean whose gameKey is also an open bet on Pending gets no separate row; the Leans M formula (VLOOKUP on gameKey) picks up the bet's close.
- **Lean rows in `/closing?format=csv`:** `id` = lean id (`lean_…`), `sheetRow` = Leans row number (header = row 1), `gameKey`, `closeFair`, **`clvPct` blank** (the sheet computes N from the unboosted price), **`source` = `lean`**, `missing`, `capturedAt`. Bet rows are unchanged (source `main` / `alt` / `prop`).
- **Team totals** (`team_totals`, gameKey like `eventId|team_totals|Buffalo Bills Over|30.5`): the monitor also pulls Pinnacle's team totals and alternate team totals. If Pinnacle has no price at that number, the row comes through with `missing` filled and `closeFair` blank (today's Bills TT may be one of these).
- Only leans logged before the game starts can get a close. Past leans with no captured close stay blank.
- Importing the CSV into Closes as usual is all the sheet needs. Check: the 11/22 Over 48.5 (Saints @ Bears) row should fill M/N after kickoff.

## 2. Injury status changes on alerts (information only)
- Source: ESPN's free injuries feed. **NFL, NBA, NHL** (MLB when in season). **No college**: ESPN has no usable college data.
- Alerts, edge cards and the Check price page may carry a line like
  `🩹 BUF Kincaid TE: D → Out (11:31 AM) · MIA Tagovailoa QB: Q → off report`
  showing up to 3 status changes for either team in the last 12 hours, key positions first (NFL QB/RB/WR/TE, NHL G; every NBA player counts). Prop alerts show that player's own status first.
- If a key player on either team changed status in the last 60 minutes, the alert title starts with **`⚠️ news Nm ·`** and the alert says to check the consensus line.
- **Never changes EV, stake or grade.** ESPN posts changes minutes after the news breaks, so these lines explain why a price is off more than they help get in early.
- **How to use it:** on a `⚠️ news` alert, follow the consensus line. ✓ agrees means the book is probably slow (bet if still +EV); ✗ disagrees means Pinnacle probably hasn't caught up with the news yet (pass). No new sheet columns are needed. If you want to track it, a note like "news alert" in the bet's notes is enough.

## Unchanged
Paper test (v2), $5 flat stakes on alert bets, thresholds, books and the Dec 2 paper-test review. Full details: `docs/how-edges-work.md` sections 9 and 12 in the repo.
