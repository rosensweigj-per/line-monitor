# Line alerts

Netlify scheduled function that scans Jason's sportsbooks against Pinnacle's devigged fair price
every 15 minutes and sends +EV alerts to Pushover (ntfy optional). No Claude involved.

- `netlify/functions/line-monitor.mts`: scheduled run (`*/15 * * * *` UTC; only runs 9 AM–10 PM ET)
- `netlify/functions/status.mts`: `/status?token=RUN_TOKEN` last run · `&run=1` scan now · `&test=1` test push
- `netlify/functions/edges.mts`: `/edges?token=RUN_TOKEN` phone page of open edges
- `lib/scan.mjs`: devig + EV math · `lib/run.mjs`: cadence, credit guard, dedupe, push

Env vars (Netlify site settings): `ODDS_API_KEY`, `RUN_TOKEN`, `PUSHOVER_TOKEN` (app API token),
`PUSHOVER_USER` (your user key). Optional: `PUSHOVER_SOUND`, `NTFY_TOPIC` (also push to ntfy).
Alerts with a +5% line go out as Pushover priority 1 (bypasses Pushover quiet hours).
Tuning: `MIN_EV` (0.03), `MIN_REMAINING` (3000), `SPORTS`, `NEAR_INTERVAL_MIN` (15),
`FAR_INTERVAL_MIN` (60), `ACTIVE_START_HOUR_ET` (9), `ACTIVE_END_HOUR_ET` (22).

Spreads/totals also match when a book has a better number than Pinnacle (e.g. +3.5 vs Pin +3);
the EV shown is then a floor ("EV ≥"), since Pin's probability at its own number understates it.

Tests: `npm test`
