// Downloaded cover-art blobs, stored in Cache Storage keyed by the track's
// stable art URL so the service worker (public/sw.js) can answer <img>
// requests for it offline. Mirrors audio-cache.ts; art needs no Range
// handling, so the SW just serves the stored response as-is.

import { artSrc } from "@/lib/api";

// Must match ART_CACHE in public/sw.js.
const ART_CACHE = "wt-art";

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
