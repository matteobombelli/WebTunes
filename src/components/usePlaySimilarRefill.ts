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
  // Once a seed's similar pool runs dry, stop hammering the API for that seed.
  // Keyed to the seed actually used (not the frozen original): in drift mode the
  // seed changes as the queue advances, so an exhausted seed only pauses refills
  // until a fresher track becomes current. In frozen mode the seed never
  // changes, so the radio just plays out the remaining queue and ends.
  const exhaustedSeedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!playSimilar || !similarSeedId || index < 0) return;
    if (fetchingRef.current) return;
    const upcoming = queueLength - index - 1;
    if (upcoming > REFILL_THRESHOLD) return;

    const st = usePlayerStore.getState();
    // Drift: rank each refill against the track playing now so the radio
    // evolves; otherwise stay anchored to the original frozen seed.
    const seedId = st.similarDrift
      ? st.queue[st.index]?.track.id ?? similarSeedId
      : similarSeedId;
    // Skip only if *this* seed is the one that ran dry — a different drift seed
    // gets a fresh chance.
    if (exhaustedSeedRef.current === seedId) return;

    fetchingRef.current = true;
    fetchSimilarTracks(seedId, st.similarSeen, REFILL_COUNT)
      .then((tracks) => {
        // The user may have switched modes/seed while the fetch was in flight.
        const s = usePlayerStore.getState();
        if (!s.playSimilar || s.similarSeedId !== similarSeedId) return;
        if (tracks.length > 0) s.advanceSimilar(tracks);
        // Only stop refilling this seed when the pool is truly empty — a short
        // batch (fewer than requested) is still progress; keep going.
        if (tracks.length === 0) exhaustedSeedRef.current = seedId;
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
