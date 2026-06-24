"use client";

import { useEffect, useRef } from "react";
import { fetchSimilarTracks } from "@/lib/api";
import { usePlayerStore } from "@/stores/player";

// Keep the "play similar" radio topped up: when the queue gets within
// REFILL_THRESHOLD of the end, pull REFILL_COUNT more similar tracks. Mounted
// once by PlayerBar.
const REFILL_THRESHOLD = 5;
const REFILL_COUNT = 5;

export function usePlaySimilarRefill() {
  const playSimilar = usePlayerStore((s) => s.playSimilar);
  const similarSeedId = usePlayerStore((s) => s.similarSeedId);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const index = usePlayerStore((s) => s.index);

  const fetchingRef = useRef(false);
  // Once the seed's similar pool runs dry, stop hammering the API; the radio
  // just plays out the remaining queue and ends.
  const exhaustedSeedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!playSimilar || !similarSeedId || index < 0) return;
    if (exhaustedSeedRef.current === similarSeedId) return;
    if (fetchingRef.current) return;
    const upcoming = queueLength - index - 1;
    if (upcoming > REFILL_THRESHOLD) return;

    fetchingRef.current = true;
    const offset = usePlayerStore.getState().similarOffset;
    fetchSimilarTracks(similarSeedId, offset, REFILL_COUNT)
      .then((tracks) => {
        // The user may have switched modes/seed while the fetch was in flight.
        const s = usePlayerStore.getState();
        if (!s.playSimilar || s.similarSeedId !== similarSeedId) return;
        if (tracks.length > 0) s.advanceSimilar(tracks);
        if (tracks.length < REFILL_COUNT) exhaustedSeedRef.current = similarSeedId;
      })
      .catch(() => {
        // Transient failure (offline, etc.); a later queue change retries.
      })
      .finally(() => {
        fetchingRef.current = false;
      });
  }, [playSimilar, similarSeedId, queueLength, index]);

  // Leaving similar mode clears exhaustion so a future enable can refill again.
  useEffect(() => {
    if (!playSimilar) exhaustedSeedRef.current = null;
  }, [playSimilar]);
}
