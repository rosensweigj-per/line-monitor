import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { renderCheck } from "../../lib/page.mjs";
import { fetchAltLines, fetchEvent } from "../../lib/run.mjs";
import { candidatesFrom, priceBetterNumbers } from "../../lib/alt.mjs";
import { BOOKS, parseCheckParams, recheck, resolveBooks } from "../../lib/scan.mjs";
import { loadSettings, minEvFor, withSettings } from "../../lib/settings.mjs";
import { betFlags, loadOpenBets } from "../../lib/bets.mjs";

// GET /check?token=…&s=sport&e=event&m=market&n=side&d=player&b=book&o=odds&p=point&f=fair&pp=pinPrice&x=ev&t=foundAt
// Re-pulls just that game and market (about 1 credit) and shows whether the edge is still there.
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  const q = url.searchParams;
  if (!token || q.get("token") !== token) return new Response("Not found", { status: 404 });

  const { then, sport, eventId, market, side, player, ok } = parseCheckParams(q);
  const book = BOOKS[then.bookKey as keyof typeof BOOKS] || then.bookKey;

  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const env = withSettings((k: string) => Netlify.env.get(k)?.trim(), await loadSettings(store));
  const minEv = minEvFor(env, market, sport);

  let result = null, error = null, game = "", start = null;
  if (!ok) {
    error = "link is missing details";
  } else {
    try {
      const r = await fetchEvent({ key: env("ODDS_API_KEY"), sport, eventId, markets: market });
      const ev = r.json;
      game = ev?.away_team ? `${ev.away_team} @ ${ev.home_team}` : "";
      start = ev?.commence_time || null;
      result = recheck(ev, sport, { market, side, player, bookKey: then.bookKey });
      const rh = (result as any)?.hit;
      if (rh?.betterLine) {
        // same better-number pricing as the scan (shares its 15-min cache and daily cap)
        const cands = candidatesFrom([rh], () => -1, { windowH: Infinity });
        const { refined } = await priceBetterNumbers(cands.length ? cands : [], {
          store, cap: Number(env("ALT_DAILY_CAP") ?? 100),
          fetchAlt: ({ sport: s2, eventId: e2, markets }) => fetchAltLines({ key: env("ODDS_API_KEY"), sport: s2, eventId: e2, markets }),
        });
        if (refined[0]) (result as any).hit = refined[0];
      }
    } catch (e) {
      error = /HTTP 404/.test((e as Error).message) ? "game not found (it may have started)" : (e as Error).message;
    }
  }
  const { open } = await loadOpenBets(store, env);
  const hit = result && (result as any).status === "ok" ? (result as any).hit : null;
  const flags = ok ? betFlags({ eventId, market, side, player, point: hit?.point ?? then.point, bookKey: then.bookKey, book }, open) : [];
  const pick = market === "h2h" ? `${side} ML`
    : player ? `${player} ${side} ${then.point ?? ""}`
    : `${side} ${market === "spreads" && (then.point ?? 0) > 0 ? "+" : ""}${then.point ?? ""}`;
  return new Response(
    renderCheck({ then: { ...then, market, sportKey: sport }, result, error, token, minEv, book, pick: pick.trim(), game, start, shortcutBooks: resolveBooks(env("BOOK_SHORTCUTS") || ""), flags }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
};

export const config: Config = { path: "/check" };
