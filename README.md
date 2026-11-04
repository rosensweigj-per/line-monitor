# Line alerts

Netlify scheduled function that scans Jason's sportsbooks against Pinnacle's devigged fair price
every 15 minutes and sends +EV alerts to Pushover (ntfy optional). No Claude involved.

- `netlify/functions/line-monitor.mts`: scheduled run (`*/15 * * * *` UTC; skips 12–9 AM ET itself)
- `netlify/functions/status.mts`: `/status?token=RUN_TOKEN` last run · `&run=1` scan now · `&test=1` test push
- `lib/scan.mjs`: devig + EV math · `lib/run.mjs`: cadence, credit guard, dedupe, push

Env vars (Netlify site settings): `ODDS_API_KEY`, `RUN_TOKEN`, `PUSHOVER_TOKEN` (app API token),
`PUSHOVER_USER` (your user key). Optional: `PUSHOVER_SOUND`, `NTFY_TOPIC` (also push to ntfy).
Alerts with a +5% line go out as Pushover priority 1 (bypasses Pushover quiet hours).
Tuning: `MIN_EV` (0.03), `MIN_REMAINING` (3000), `SPORTS`, `NEAR_INTERVAL_MIN` (15),
`FAR_INTERVAL_MIN` (60), `ACTIVE_START_HOUR_ET` (9), `ACTIVE_END_HOUR_ET` (24).
