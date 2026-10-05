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

  // Keyed by id strings, not the queue array: refills and metadata edits
  // replace the array, and re-running would abort an in-flight prefetch.
  const seen = new Set<string>();
  for (const { track } of [
    ...queue.slice(0, 10),
    ...queue.slice(-10),
    ...queue.slice(Math.max(0, index - 3), index + 4),
  ]) {
    if (track.artS3Key) seen.add(track.id);
  }
  const artKey = [...seen].join(",");
  const audioKey =
    index < 0
      ? ""
      : [
          queue[index]?.track.id ?? "",
          ...queue
            .slice(index + 1, index + 1 + PREFETCH_AHEAD)
            .map(({ track }) => track.id),
        ].join(",");

  useEffect(() => {
    if (!armed || !artKey) return;
    for (const id of artKey.split(",")) {
      const image = new Image();
      image.src = artSrc(id, { thumb: true });
    }
  }, [armed, artKey]);

  useEffect(() => {
    if (!armed) return;
    if (!audioKey) return;
    // Audio pre-caching works around mobile background network throttling;
    // desktop browsers don't throttle, so skip the downloads and disk writes.
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const [currentId, ...nextIds] = audioKey.split(",");
    prefetchUpcoming(currentId || undefined, nextIds);
  }, [armed, audioKey]);

  return null;
});
