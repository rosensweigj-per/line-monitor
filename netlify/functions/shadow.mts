import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { renderShadow } from "../../lib/page.mjs";
import { summarizeShadow } from "../../lib/shadow.mjs";

// GET /shadow?token=RUN_TOKEN[&since=YYYY-MM-DD][&format=json|csv] -> paper test, Pinnacle vs consensus method.
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
  const shadow = ((await getStore({ name: "line-monitor", consistency: "strong" }).get("shadow", { type: "json" })) || {}) as Record<string, any>;
  const sinceQ = Date.parse(url.searchParams.get("since") || "");
  const since = Number.isFinite(sinceQ) ? sinceQ : 0;
  const rows = Object.values(shadow).filter((e: any) => Date.parse(e.at) >= since).sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at));
  const summary = summarizeShadow(shadow, { since });
  const fmt = url.searchParams.get("format");
  if (fmt === "json") return Response.json({ summary, entries: rows }, { headers: { "cache-control": "no-store" } });
  if (fmt === "csv") {
    const cols = ["at", "method", "sport", "game", "start", "market", "side", "player", "point", "book", "odds", "ev", "fair", "consClose", "consClv", "pinClose", "pinClv", "result", "units"];
    const cell = (v: any) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const csv = [cols.join(","), ...rows.map((e: any) => cols.map((c) => cell(e[c])).join(","))].join("\n") + "\n";
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(renderShadow({ summary, recent: rows.slice(0, 40), token, since: since || null }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config: Config = { path: "/shadow" };
