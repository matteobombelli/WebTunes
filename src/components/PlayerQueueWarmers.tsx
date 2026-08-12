"use client";

import { memo, useEffect } from "react";
import { artSrc } from "@/lib/api";
import { PREFETCH_AHEAD, prefetchUpcoming } from "@/lib/offline/prefetch";
import { usePlayerStore } from "@/stores/player";

/** Warm nearby art and upcoming audio without re-rendering the player bar. */
export default memo(function PlayerQueueWarmers() {
  const queue = usePlayerStore((state) => state.queue);
  const index = usePlayerStore((state) => state.index);

  useEffect(() => {
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
  }, [index, queue]);

  useEffect(() => {
    if (index < 0) return;
    const nextIds = queue
      .slice(index + 1, index + 1 + PREFETCH_AHEAD)
      .map(({ track }) => track.id);
    prefetchUpcoming(queue[index]?.track.id, nextIds);
  }, [index, queue]);

  return null;
});
