import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { renderEdges } from "../../lib/page.mjs";
import { runMonitor } from "../../lib/run.mjs";
import { resolveBooks } from "../../lib/scan.mjs";
import { loadSettings, withSettings } from "../../lib/settings.mjs";
import { betFlags, loadOpenBets } from "../../lib/bets.mjs";

// GET  /edges?token=RUN_TOKEN -> phone-friendly page of the edges from each sport's latest pull.
// POST /edges?token=RUN_TOKEN -> "Scan now" button: full scan (ignores cadence and quiet hours), then back to the page.
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) {
    return new Response("Not found", { status: 404 });
  }
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  if (req.method === "POST") {
    await runMonitor({ store, env: (k: string) => Netlify.env.get(k)?.trim(), force: true });
    const back = new URL(`/edges?token=${encodeURIComponent(token)}&scanned=1`, url);
    return Response.redirect(back.toString(), 303);
  }
  const [edges, state, lastRun, saved] = await Promise.all([
    store.get("edges", { type: "json" }),
    store.get("state", { type: "json" }),
    store.get("lastRun", { type: "json" }),
    loadSettings(store),
  ]);
  const env = withSettings((k: string) => Netlify.env.get(k)?.trim(), saved);
  const shortcutBooks = resolveBooks(env("BOOK_SHORTCUTS") || "");
  const { open } = await loadOpenBets(store, env);
  const flagsFor = (h: any) => betFlags(h, open);
  return new Response(renderEdges({ edges, state, lastRun, now: Date.now(), token, scanned: url.searchParams.has("scanned"), shortcutBooks, flagsFor }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config: Config = { path: "/edges" };
