// Downloaded audio blobs, stored in Cache Storage keyed by the track's
// stable stream URL so the service worker (public/sw.js) can answer the
// player's requests for it offline.

import { streamSrc } from "@/lib/api";

// Must match AUDIO_CACHE in public/sw.js.
const AUDIO_CACHE = "wt-audio";

export async function putAudio(trackId: string, blob: Blob, mimeType: string | null) {
  const cache = await caches.open(AUDIO_CACHE);
  await cache.put(
    streamSrc(trackId),
    new Response(blob, {
      headers: {
        // The SW echoes these when serving (incl. 206 slices); without a
        // real audio Content-Type iOS may refuse to play.
        "Content-Type": mimeType || blob.type || "application/octet-stream",
        "Content-Length": String(blob.size),
      },
    })
  );
}

export async function hasAudio(trackId: string): Promise<boolean> {
  const cache = await caches.open(AUDIO_CACHE);
  return (await cache.match(streamSrc(trackId))) !== undefined;
}

/**
 * Batched hasAudio: one cache.keys() pass instead of a match() per id, for the
 * playlist download/sync paths that check many tracks at once. Returns the
 * subset of ids whose audio is cached.
 */
export async function hasManyAudio(trackIds: string[]): Promise<Set<string>> {
  const cache = await caches.open(AUDIO_CACHE);
  const cachedPaths = new Set(
    (await cache.keys()).map((req) => new URL(req.url).pathname)
  );
  return new Set(trackIds.filter((id) => cachedPaths.has(streamSrc(id))));
}

export async function deleteAudio(trackId: string) {
  const cache = await caches.open(AUDIO_CACHE);
  await cache.delete(streamSrc(trackId));
}
