// Ephemeral pre-cache of the *next* track's audio. iOS throttles live network
// fetches for a backgrounded PWA, so when a streamed track ends in the
// background the auto-advance can't load the next track and sits silently
// stuck. Warming the next track into Cache Storage while the current one plays
// (in the foreground, where the network works) lets the service worker
// (public/sw.js) serve that advance from cache with no live fetch. Distinct
// from wt-audio (user downloads): holds only the current + next track and is
// best-effort — any failure just falls back to the live (throttled) fetch.

import { streamSrc } from "@/lib/api";
import { hasAudio } from "@/lib/offline/audio-cache";

// Must match PREFETCH_CACHE in public/sw.js.
const PREFETCH_CACHE = "wt-prefetch";

/**
 * Warm the next track's audio for a cache-served background advance, keeping
 * only the current + next track in the prefetch cache. The current id is kept
 * (not just the next) because the just-advanced-to track is served from here
 * until the element has it buffered — pruning to next-only would evict it mid
 * hand-off. No-op for already-downloaded tracks (served from wt-audio) and
 * when offline.
 */
export async function prefetchUpcoming(
  currentId: string | undefined,
  nextId: string | undefined
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await pruneExcept([currentId, nextId]);
    if (!nextId) return;
    if (await hasAudio(nextId)) return; // already a download → served from wt-audio
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const cache = await caches.open(PREFETCH_CACHE);
    const url = streamSrc(nextId);
    if (await cache.match(url)) return; // already warmed
    const res = await fetch(url); // SW → 302 → presigned S3
    if (res.ok) await cache.put(url, res);
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
