import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { renderEdges } from "../../lib/page.mjs";

// GET /edges?token=RUN_TOKEN -> phone-friendly page of the edges from each sport's latest pull.
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) {
    return new Response("Not found", { status: 404 });
  }
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const [edges, state, lastRun] = await Promise.all([
    store.get("edges", { type: "json" }),
    store.get("state", { type: "json" }),
    store.get("lastRun", { type: "json" }),
  ]);
  return new Response(renderEdges({ edges, state, lastRun, now: Date.now() }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config: Config = { path: "/edges" };
