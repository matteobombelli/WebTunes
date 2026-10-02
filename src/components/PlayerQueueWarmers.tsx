"use client";

import { memo, useEffect, useState } from "react";
import { artSrc } from "@/lib/api";
import { PREFETCH_AHEAD, prefetchUpcoming } from "@/lib/offline/prefetch";
import { usePlayerStore } from "@/stores/player";

/** How long to wait for the current slot to report playback before warming anyway. */
const WARM_FALLBACK_MS = 2500;

/** Warm nearby art and upcoming audio without re-rendering the player bar. */
export default memo(function PlayerQueueWarmers({
  startedUid,
}: {
  startedUid: string | null;
}) {
  const queue = usePlayerStore((state) => state.queue);
  const index = usePlayerStore((state) => state.index);
  const currentUid = index >= 0 ? (queue[index]?.uid ?? null) : null;
  const [armedUid, setArmedUid] = useState<string | null>(null);

  useEffect(() => {
    if (currentUid === null) return;
    if (startedUid === currentUid) {
      setArmedUid(currentUid);
      return;
    }
    // Background iOS advances may never surface `playing`, and the next track
    // must still be warmed or auto-advance stalls.
    const t = setTimeout(() => setArmedUid(currentUid), WARM_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [currentUid, startedUid]);

  // Derived, so a new tap un-arms instantly without an extra render.
  const armed = armedUid !== null && armedUid === currentUid;

  useEffect(() => {
    if (!armed) return;
    const seen = new Set<string>();
    const nearby = [
      ...queue.slice(0, 10),
      ...queue.slice(-10),
      ...queue.slice(Math.max(0, index - 3), index + 4),
    ];
    for (const { track } of nearby) {
      if (!track.artS3Key || seen.has(track.id)) continue;
      seen.add(track.id);
      const image = new Image();
      image.src = artSrc(track.id, { thumb: true });
    }
  }, [armed, index, queue]);

  useEffect(() => {
    if (!armed) return;
    if (index < 0) return;
    // Audio pre-caching works around mobile background network throttling;
    // desktop browsers don't throttle, so skip the downloads and disk writes.
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const nextIds = queue
      .slice(index + 1, index + 1 + PREFETCH_AHEAD)
      .map(({ track }) => track.id);
    prefetchUpcoming(queue[index]?.track.id, nextIds);
  }, [armed, index, queue]);

  return null;
});
