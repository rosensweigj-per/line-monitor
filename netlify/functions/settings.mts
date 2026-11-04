import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { renderSettings } from "../../lib/page.mjs";
import { currentSettings, loadSettings, parseSettingsForm, withSettings } from "../../lib/settings.mjs";

// GET  /settings?token=RUN_TOKEN          -> settings form (books, sports, props, EV, hours)
// POST /settings?token=RUN_TOKEN          -> save (overrides Netlify env vars of the same name)
// POST /settings?token=RUN_TOKEN&reset=1  -> clear saved settings, back to env vars
export default async (req: Request) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || url.searchParams.get("token") !== token) {
    return new Response("Not found", { status: 404 });
  }
  const store = getStore({ name: "line-monitor", consistency: "strong" });
  const back = (q: string) =>
    Response.redirect(new URL(`/settings?token=${encodeURIComponent(token)}${q}`, url).toString(), 303);

  if (req.method === "POST") {
    if (url.searchParams.has("reset")) {
      await store.delete("settings");
      return back("&saved=1");
    }
    await store.setJSON("settings", parseSettingsForm(await req.formData()));
    return back("&saved=1");
  }

  const saved = await loadSettings(store);
  const env = withSettings((k: string) => Netlify.env.get(k)?.trim(), saved);
  return new Response(
    renderSettings({ cur: currentSettings(env), token, saved: url.searchParams.has("saved"), custom: Object.keys(saved).length > 0 }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
};

export const config: Config = { path: "/settings" };
