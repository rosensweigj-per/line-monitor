# Line alerts

Netlify scheduled function that scans Jason's sportsbooks against Pinnacle's devigged fair price
every 5–60 minutes and sends +EV alerts to Pushover (ntfy optional). No Claude involved.

- `netlify/functions/line-monitor.mts`: scheduled run (`*/5 * * * *` UTC; only runs 9 AM–10 PM ET;
  each sport every 5 min within 1h of a game, 15 min within 4h, else hourly)
- `netlify/functions/status.mts`: `/status?token=RUN_TOKEN` last run · `&run=1` scan now · `&test=1` test push
- `netlify/functions/edges.mts`: `/edges?token=RUN_TOKEN` phone page of open edges + Recent alerts (until game start), with Scan now + Settings
- `netlify/functions/settings.mts`: `/settings?token=RUN_TOKEN` books, sports, props, EV, scan intervals, hours. Saved to Blobs;
  overrides env vars of the same name (no redeploy). "Reset to Netlify values" clears them.
- `netlify/functions/best.mts`: `/best?token=…&q=mich st` every book's ML/spread/total for a team's next games, best first, EV vs Pin (~3 credits/game)
- `netlify/functions/check.mts`: `/check?token=…&…` re-prices one bet live (about 1 credit): price/fair/EV then vs now.
  Alerts and edge cards link here first; it then offers Open <book>.
- `lib/scan.mjs`: devig + EV math · `lib/run.mjs`: cadence, credit guard, dedupe, push

Env vars (Netlify site settings): `ODDS_API_KEY`, `RUN_TOKEN`, `PUSHOVER_TOKEN` (app API token),
`PUSHOVER_USER` (your user key). Optional: `PUSHOVER_SOUND`, `NTFY_TOPIC` (also push to ntfy).
One Pushover alert per edge (top `ALERT_MAX_INDIVIDUAL`, default 5, each with its own check link; the rest in one summary
linking to /edges). Alerts expire after `ALERT_TTL_MIN` (10; 0 = never) and show when the edge was found. The check link uses
Netlify's `URL` (override with `SITE_URL`). Alerts with a +5% line go out as Pushover priority 1 (bypasses Pushover quiet hours).
Tuning: `MIN_EV` (0.03; per market `MIN_EV_ML`, `MIN_EV_SPREAD`, `MIN_EV_TOTAL` override it), `MIN_REMAINING` (3000), `SPORTS`, `TIP_INTERVAL_MIN` (5), `NEAR_INTERVAL_MIN` (15),
`FAR_INTERVAL_MIN` (60), `ACTIVE_START_HOUR_ET` (9), `ACTIVE_END_HOUR_ET` (22).

Books: `BOOKS_OFF` turns books off by key or label, e.g. `fanatics,Hard Rock,DK`. Each alert has a tap-to-open
link to the best book (Odds API deep link when available, else the book's site; `BOOK_STATE`, default `va`).
`BOOK_SHORTCUTS` (or Settings) makes a book's button run an iPhone Shortcut named "Open <Book>" instead, for apps
whose web links don't open the app (BetRivers: va.betrivers.com has no apple-app-site-association).

Stakes (lib/scan.mjs `stakeFor`): EV 3–4.9% $10, 5–7.9% $15, 8–11.9% $25, 12%+ $30 + "VERIFY: stale Pinnacle / injury?"
(below 3%, only if a threshold is lowered: $5). Better-number alerts size off the EV floor. Then +200 or longer halves,
NCAAF spreads cap $10, round to nearest $5 (min $5). Grade by EV: 8%+ A+, 6–7.9 A, 4–5.9 B, 3–3.9 C, <3 D.

"Already bet" flags (lib/bets.mjs): reads the Bet Tracker sheet's `Pending` tab (A:T), READ-ONLY (spreadsheets.readonly
scope, values GET only; never writes). Open rows (status pending/blank, incl. bonus/hedge rows) with column `gameKey` = `oddsApiEventId|market|side|point`
(props: side = "Player Over|Under"; point blank for ML). Tags alerts, edge cards and the check page: same side,
other side (hedge/middle), other side at the same book (conflict), same game other market. Never suppresses.
Env: `BET_TRACKER_CSV_URL` (the Pending tab published to the web as CSV; simplest, used first) or
`GOOGLE_SA_EMAIL` + `GOOGLE_SA_KEY` (or `GOOGLE_SERVICE_ACCOUNT_JSON`); optional `BET_TRACKER_SHEET_ID`,
`BET_TRACKER_TAB` (Pending). Share the sheet with the service account as Viewer. Cached 2 min in Blobs.

Spreads/totals also match when a book has a better number than Pinnacle (e.g. +3.5 vs Pin +3). Base EV is a floor
("EV ≥"). lib/alt.mjs then re-prices better numbers within 1 pt, for games within `ALT_WINDOW_HOURS` (4), whose floor EV
> -7% (-5% basketball) (or whose key-number model EV
is near the bar): Pinnacle's alternate line at the exact number (one alternate_spreads/alternate_totals call per game,
bookmakers=pinnacle, cached 15 min in the last hour / 30 min within 4h / 60 min beyond, shared by all books), else landing chances from Pin's alt ladder, else the model
only for NFL/NCAAF spreads crossing 3 or 7 ("model"). Alts only within 1.5 pts of the main line and < 45 min old;
alt vs model > 3 pts of probability -> CHECK (shown on /edges, never alerted). `ALT_DAILY_CAP` (100 credits/day,
Settings; 0 = no alt fetches). /status `altPricing` shows candidates, fetches, alt/ladder/model/check/floor counts.

Player props: one Odds API call per game (cost = prop markets returned), hourly, for games starting
within 6h. `PROP_SPORTS` (basketball_nba; add americanfootball_nfl; `off` disables), `PROP_MARKETS` (player_points; one
comma list for all sports, each sport only requests its own markets, see `PROP_CATALOG` in lib/scan.mjs),
`PROP_MIN_EV` (0.04), `PROP_INTERVAL_MIN` (60), `PROP_WINDOW_HOURS` (6). `SPORTS=off` also works.

Tests: `npm test`
