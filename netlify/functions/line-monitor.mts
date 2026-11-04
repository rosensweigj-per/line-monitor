import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { runMonitor } from "../../lib/run.mjs";

// Every 5 minutes (UTC cron). The runner itself skips quiet hours (outside 9 AM–10 PM ET) and pulls
// each sport every 5 min when a game is within 1h, every 15 min within 4h, otherwise hourly.
export default async () => {
  const summary = await runMonitor({
    store: getStore({ name: "line-monitor", consistency: "strong" }),
    env: (k: string) => Netlify.env.get(k)?.trim(),
  });
  console.log(JSON.stringify(summary));
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
