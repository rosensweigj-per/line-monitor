import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { CSS } from "../../lib/page.mjs";
import { fetchEvent } from "../../lib/run.mjs";
import { findGames } from "../../lib/best.mjs";
import { buildLegs, renderSgp, SGP_SPORTS, sgpMarkets } from "../../lib/sgp.mjs";
import { resolveBooks } from "../../lib/scan.mjs";
import { loadSettings, withSettings } from "../../lib/settings.mjs";

// GET /sgp?token=…&q=lions            -> NFL/NBA games for that team (free events endpoint)
// GET /sgp?token=…&s=sport&e=eventId  -> one game's legs at every book (about 7 credits; cached 5 min)
// Optional &boost=30&b=fanduel. Information only; nothing is bet.
const CACHE_MS = 5 * 60e3;

export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  const q = url.searchParams;
  if (!token || q.get("token") !== token) return new Response("Not found", { status: 404 });
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const env = withSettings((k: string) => Netlify.env.get(k)?.trim(), await loadSettings(store));
  const key = env("ODDS_API_KEY");
  const boost = Math.max(0, Math.min(200, Number(q.get("boost") ?? 30) || 0));
  const query = (q.get("q") || "").trim().slice(0, 60);
  const sport = q.get("s") || "";
  const eventId = q.get("e") || "";
  const html = (o: object) => new Response(renderSgp({ q: query, token, css: CSS, boost, bookKey: q.get("b") || "", ...o }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  try {
    if (sport && eventId && SGP_SPORTS.includes(sport)) {
      const cache = ((await store.get("sgpCache", { type: "json" })) || {}) as Record<string, { at: number; json: any }>;
      const now = Date.now();
      let ev = cache[eventId] && now - cache[eventId].at < CACHE_MS ? cache[eventId].json : null;
      if (!ev) {
        ev = (await fetchEvent({ key, sport, eventId, markets: sgpMarkets(sport) })).json;
        cache[eventId] = { at: now, json: ev };
        for (const [k, v] of Object.entries(cache)) if (now - v.at > CACHE_MS) delete cache[k];
        await store.setJSON("sgpCache", cache);
      }
      const books = buildLegs(ev, sport, { skipBooks: resolveBooks(env("BOOKS_OFF") || "") });
      return html({ event: ev, sport, books });
    }
    if (!query) return html({});
    const eventsBySport: Record<string, any[]> = {};
    await Promise.all(SGP_SPORTS.map(async (s) => {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${s}/events?apiKey=${key}`);
      eventsBySport[s] = r.ok ? await r.json() : [];
    }));
    return html({ found: findGames(eventsBySport, query).slice(0, 5) });
  } catch (e) {
    const msg = (e as Error).message;
    return html({ error: /HTTP 404/.test(msg) ? "Game not found (it may have started)." : msg });
  }
};

export const config: Config = { path: "/sgp" };
