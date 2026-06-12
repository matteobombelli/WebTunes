"use client";

import { useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { useDownloadsStore } from "@/stores/downloads";

// Must match SHELL_CACHE in public/sw.js.
const SHELL_CACHE = "wt-shell-v1";

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    // Hydrate the downloads store (and kick playlist auto-sync when online)
    // once per app load, wherever the user lands.
    void useDownloadsStore.getState().init();
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(`${BASE_PATH}/sw.js`, {
        scope: `${BASE_PATH}/`,
        updateViaCache: "none",
      })
      .then(() => primeOfflineFallback())
      .catch(() => {
        // The SW is progressive enhancement; the app works without it.
      });
  }, []);
  return null;
}

// Cache the downloads page (the offline entry point) so it renders offline
// even if the user never visited it. The HTML alone is not enough: the page
// renders client-side from IndexedDB, so without its script/style chunks
// hydration fails offline and the page stays blank — prime those too.
// Re-primed once per session so it stays fresh across deploys.
async function primeOfflineFallback() {
  const url = `${BASE_PATH}/downloads`;
  try {
    if (sessionStorage.getItem("wt-offline-primed")) return;
    const res = await fetch(url);
    // A redirect means we're unauthenticated and got the login page —
    // caching that under /downloads would break the offline fallback.
    if (!res.ok || res.redirected) return;
    const html = await res.text();
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(
      url,
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
    const assets = new Set<string>();
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]*\/_next\/[^"]+)"/g)) {
      assets.add(asset.replace(/&amp;/g, "&"));
    }
    await Promise.all(
      [...assets].map(async (asset) => {
        if (await cache.match(asset)) return;
        const assetRes = await fetch(asset);
        if (assetRes.ok) await cache.put(asset, assetRes);
      })
    );
    sessionStorage.setItem("wt-offline-primed", "1");
  } catch {
    // Offline or storage unavailable; the SW's navigation caching will pick
    // the page up on a later online visit.
  }
}
