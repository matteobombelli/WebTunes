// Ephemeral pre-cache of the next few tracks' audio. iOS throttles live network
// fetches for a backgrounded PWA, so when a streamed track ends in the
// background the auto-advance can't load the next track and sits silently
// stuck. Warming several upcoming tracks into Cache Storage while the current
// one plays (in the foreground, where the network works) lets the service worker
// (public/sw.js) serve consecutive background advances from cache with no live
// fetch. Distinct from wt-audio (user downloads): holds only the current + next
// few tracks and is best-effort — any failure just falls back to the live
// (throttled) fetch.

import { streamSrc } from "@/lib/api";
import { hasAudio } from "@/lib/offline/audio-cache";

// Must match PREFETCH_CACHE in public/sw.js.
const PREFETCH_CACHE = "wt-prefetch";

/** How many upcoming tracks to keep warmed (bounds the wt-prefetch cache to N+1). */
export const PREFETCH_AHEAD = 3;

/**
 * Warm the next few tracks' audio for cache-served background advances, keeping
 * only the current + those tracks in the prefetch cache. The current id is kept
 * (not just the next) because the just-advanced-to track is served from here
 * until the element has it buffered — pruning to next-only would evict it mid
 * hand-off. Warms sequentially (most-imminent first) so it doesn't blast the
 * iOS-throttled network; per-id dedup means a single advance is usually ~one
 * fetch. No-op for already-downloaded tracks (served from wt-audio) and offline.
 */
export async function prefetchUpcoming(
  currentId: string | undefined,
  nextIds: (string | undefined)[]
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await pruneExcept([currentId, ...nextIds]);
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const cache = await caches.open(PREFETCH_CACHE);
    for (const id of nextIds) {
      if (!id) continue;
      if (await hasAudio(id)) continue; // already a download → served from wt-audio
      const url = streamSrc(id);
      if (await cache.match(url)) continue; // already warmed
      const res = await fetch(url); // SW → 302 → presigned S3
      if (res.ok) await cache.put(url, res);
    }
  } catch {
    // best-effort
  }
}

/** Drop every prefetch entry except the given tracks' (ignores blanks). */
async function pruneExcept(trackIds: (string | undefined)[]): Promise<void> {
  const cache = await caches.open(PREFETCH_CACHE);
  const keep = new Set(
    trackIds.filter((id): id is string => !!id).map((id) => streamSrc(id))
  );
  for (const req of await cache.keys()) {
    if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
  }
}
