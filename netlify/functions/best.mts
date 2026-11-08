import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { CSS } from "../../lib/page.mjs";
import { fetchEvent } from "../../lib/run.mjs";
import { compareBooks, findGames, renderBest } from "../../lib/best.mjs";
import { resolveBooks } from "../../lib/scan.mjs";
import { DEFAULT_SPORTS, loadSettings, withSettings } from "../../lib/settings.mjs";

// GET /best?token=…&q=mich st -> every book's ML / spread / total for that team's next game(s), best first.
// Game search uses the free events endpoint; each game found costs about 3 credits (3 markets).
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) return new Response("Not found", { status: 404 });
  const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const env = withSettings((k: string) => Netlify.env.get(k)?.trim(), await loadSettings(store));
  const key = env("ODDS_API_KEY");
  const html = (o: object) => new Response(renderBest({ q, token, css: CSS, shortcutBooks: resolveBooks(env("BOOK_SHORTCUTS") || ""), ...o }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  if (!q) return html({});

  try {
    // Search every sport the monitor knows (not just enabled ones) so any team can be looked up.
    const sports = [...new Set([...DEFAULT_SPORTS.split(","), "baseball_mlb"])];
    const eventsBySport: Record<string, any[]> = {};
    await Promise.all(sports.map(async (s) => {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${s}/events?apiKey=${key}`);
      eventsBySport[s] = r.ok ? await r.json() : [];
    }));
    const found = findGames(eventsBySport, q).slice(0, 3);
    const skipBooks = resolveBooks(env("BOOKS_OFF") || "");
    const games = await Promise.all(found.map(async (g) => {
      const r = await fetchEvent({ key, sport: g.sport, eventId: g.event.id, markets: "h2h,spreads,totals" });
      return { ...g, event: { ...g.event, ...r.json }, cmp: compareBooks(r.json, g.team, { skipBooks }) };
    }));
    return html({ games });
  } catch (e) {
    return html({ error: (e as Error).message });
  }
};

export const config: Config = { path: "/best" };
