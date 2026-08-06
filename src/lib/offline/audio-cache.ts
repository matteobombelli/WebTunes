// Downloaded audio blobs, stored in Cache Storage keyed by the track's
// stable stream URL so the service worker (public/sw.js) can answer the
// player's requests for it offline.

import { streamSrc } from "@/lib/api";

// Must match AUDIO_CACHE in public/sw.js.
const AUDIO_CACHE = "wt-audio";

const CANONICAL_AUDIO_TYPE: Record<string, string> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/x-aac": "audio/aac",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
  "audio/ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/webm": "audio/webm",
};

function safeAudioType(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    const normalized = value?.split(";", 1)[0].trim().toLowerCase();
    if (normalized && CANONICAL_AUDIO_TYPE[normalized]) {
      return CANONICAL_AUDIO_TYPE[normalized];
    }
  }
  return "application/octet-stream";
}

export async function putAudio(trackId: string, blob: Blob, mimeType: string | null) {
  const cache = await caches.open(AUDIO_CACHE);
  await cache.put(
    streamSrc(trackId),
    new Response(blob, {
      headers: {
        // The SW echoes these when serving (incl. 206 slices); without a
        // real audio Content-Type iOS may refuse to play.
        "Content-Type": safeAudioType(mimeType, blob.type),
        "Content-Length": String(blob.size),
        "X-Content-Type-Options": "nosniff",
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
