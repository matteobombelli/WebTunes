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

export async function deleteAudio(trackId: string) {
  const cache = await caches.open(AUDIO_CACHE);
  await cache.delete(streamSrc(trackId));
}
