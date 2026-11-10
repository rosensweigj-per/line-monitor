import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// GET /closing?token=RUN_TOKEN[&since=ISO][&keys=gameKey1,gameKey2]
// Read-only JSON of Pinnacle closing prices the monitor captured for open bets (last ~10 min before start), at each
// bet's exact number, with CLV per bet. The tracker fetches this and writes CLV itself; the monitor never writes to
// the sheet.
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
  const closing = ((await getStore({ name: "line-monitor", consistency: "strong" }).get("closing", { type: "json" })) || {}) as Record<string, any>;
  const since = Date.parse(url.searchParams.get("since") || "");
  const keys = new Set((url.searchParams.get("keys") || "").split(",").map((k) => k.trim()).filter(Boolean));
  const closes = Object.values(closing)
    .filter((c) => (!keys.size || keys.has(c.gameKey)) && (!Number.isFinite(since) || Date.parse(c.capturedAt) >= since))
    .map(({ captured, ...c }) => c)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return Response.json({ generatedAt: new Date().toISOString(), count: closes.length, closes }, { headers: { "cache-control": "no-store" } });
};

export const config: Config = { path: "/closing" };
