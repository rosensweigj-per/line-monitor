import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { push, runMonitor } from "../../lib/run.mjs";

// GET /status?token=…            -> last run summary
// GET /status?token=…&run=1      -> run a scan now (ignores cadence and quiet hours)
// GET /status?token=…&test=1     -> send a test push
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) {
    return new Response("Not found", { status: 404 });
  }
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const env = (k: string) => Netlify.env.get(k)?.trim();

  if (url.searchParams.get("test")) {
    try {
      const sent = await push(env, "Line alerts connected", "Test push from your Netlify line monitor. Real alerts look like:\n\nNBA · Cavaliers ML +130 @ FD\n  fair +127 (Pin +122) · EV +3.1% · ~$10");
      return Response.json({ ok: true, sent });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }
  if (url.searchParams.get("run")) {
    return Response.json(await runMonitor({ store, env, force: true }));
  }
  return Response.json((await store.get("lastRun", { type: "json" })) || { note: "no runs yet" });
};

export const config: Config = { path: "/status" };
