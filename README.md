# Line alerts

Netlify scheduled function that scans Jason's sportsbooks against Pinnacle's devigged fair price
every 5–60 minutes and sends +EV alerts to Pushover (ntfy optional). No Claude involved.

- `netlify/functions/line-monitor.mts`: scheduled run (`*/5 * * * *` UTC; only runs 9 AM–10 PM ET;
  each sport every 5 min within 1h of a game, 15 min within 4h, else hourly)
- `netlify/functions/status.mts`: `/status?token=RUN_TOKEN` last run · `&run=1` scan now · `&test=1` test push
- `netlify/functions/edges.mts`: `/edges?token=RUN_TOKEN` phone page of open edges, with Scan now + Settings
- `netlify/functions/settings.mts`: `/settings?token=RUN_TOKEN` books, sports, props, EV, hours. Saved to Blobs;
  overrides env vars of the same name (no redeploy). "Reset to Netlify values" clears them.
- `lib/scan.mjs`: devig + EV math · `lib/run.mjs`: cadence, credit guard, dedupe, push

Env vars (Netlify site settings): `ODDS_API_KEY`, `RUN_TOKEN`, `PUSHOVER_TOKEN` (app API token),
`PUSHOVER_USER` (your user key). Optional: `PUSHOVER_SOUND`, `NTFY_TOPIC` (also push to ntfy).
Alerts with a +5% line go out as Pushover priority 1 (bypasses Pushover quiet hours).
Tuning: `MIN_EV` (0.03), `MIN_REMAINING` (3000), `SPORTS`, `TIP_INTERVAL_MIN` (5), `NEAR_INTERVAL_MIN` (15),
`FAR_INTERVAL_MIN` (60), `ACTIVE_START_HOUR_ET` (9), `ACTIVE_END_HOUR_ET` (22).

Books: `BOOKS_OFF` turns books off by key or label, e.g. `fanatics,Hard Rock,DK`. Each alert has a tap-to-open
link to the best book (Odds API deep link when available, else the book's site; `BOOK_STATE`, default `va`).

Spreads/totals also match when a book has a better number than Pinnacle (e.g. +3.5 vs Pin +3);
the EV shown is then a floor ("EV ≥"), since Pin's probability at its own number understates it.

Player props: one Odds API call per game (cost = prop markets returned), hourly, for games starting
within 6h. `PROP_SPORTS` (basketball_nba; `off` disables), `PROP_MARKETS` (player_points),
`PROP_MIN_EV` (0.04), `PROP_INTERVAL_MIN` (60), `PROP_WINDOW_HOURS` (6). `SPORTS=off` also works.

Tests: `npm test`
