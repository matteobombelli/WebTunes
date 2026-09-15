// Downloaded cover-art blobs, stored in Cache Storage keyed by the track's
// stable art URL so the service worker (public/sw.js) can answer <img>
// requests for it offline. Mirrors audio-cache.ts; art needs no Range
// handling, so the SW just serves the stored response as-is.

import { artSrc } from "@/lib/api";

// Must match ART_CACHE in public/sw.js.
const ART_CACHE = "wt-art";
// Must match ART_RUNTIME_CACHE in public/sw.js.
const ART_RUNTIME_CACHE = "wt-art-runtime";

export async function putArt(trackId: string, blob: Blob) {
  const cache = await caches.open(ART_CACHE);
  await cache.put(
    artSrc(trackId),
    new Response(blob, {
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "Content-Length": String(blob.size),
      },
    })
  );
}

export async function hasArt(trackId: string): Promise<boolean> {
  const cache = await caches.open(ART_CACHE);
  return (await cache.match(artSrc(trackId))) !== undefined;
}

export async function deleteArt(trackId: string) {
  const cache = await caches.open(ART_CACHE);
  await cache.delete(artSrc(trackId));
}

/**
 * Drops the service worker's runtime copies of art whose URL starts with
 * `urlPrefix` (absolute, since the SW keys on request.url). Needed after a
 * replacement upload: the art URL is stable, so the cached image would win.
 */
export async function evictRuntimeArt(urlPrefix: string) {
  try {
    const cache = await caches.open(ART_RUNTIME_CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((k) => k.url.startsWith(urlPrefix))
        .map((k) => cache.delete(k))
    );
  } catch {
    // Cache Storage can be unavailable; the stale copy then ages out on its own.
  }
}
