import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { runMonitor } from "../../lib/run.mjs";

// Every 15 minutes (UTC cron). The runner itself skips quiet hours (before 9 AM / after midnight ET)
// and pulls each sport every 15 min when a game is within 4h, otherwise hourly.
export default async () => {
  const summary = await runMonitor({
    store: getStore({ name: "line-monitor", consistency: "strong" }),
    env: (k: string) => Netlify.env.get(k),
  });
  console.log(JSON.stringify(summary));
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
