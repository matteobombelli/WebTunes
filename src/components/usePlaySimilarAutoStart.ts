"use client";

import { useEffect } from "react";
import { fetchSimilarTracks } from "@/lib/api";
import { loadRadioHistory, pushRadioHistory } from "@/lib/radio-history";
import { usePlayerStore } from "@/stores/player";

// When a single track is played while the remembered "play similar" preference
// is on, playQueue stamps `pendingSimilarSeed`; this hook fetches the first
// similar batch and starts the radio — the same seeding handlePlaySimilar does
// for the manual toggle. Mounted once by PlayerBar (beside usePlaySimilarRefill).
const SEED_COUNT = 10;

export function usePlaySimilarAutoStart() {
  const pendingSimilarSeed = usePlayerStore((s) => s.pendingSimilarSeed);

  useEffect(() => {
    if (!pendingSimilarSeed) return;
    const seedId = pendingSimilarSeed;
    let cancelled = false;
    // Pre-seed exclusions with recently-served tracks so restarting near the
    // same neighbourhood doesn't replay it (similarSeen is session-only).
    const history = loadRadioHistory();
    fetchSimilarTracks(seedId, [seedId, ...history], SEED_COUNT)
      .then((similar) => {
        if (cancelled) return;
        const s = usePlayerStore.getState();
        // The user may have moved on (clicked another track) while in flight.
        if (s.pendingSimilarSeed !== seedId) return;
        s._clearPendingSimilar();
        // Bail if the pref was cleared (exception) or our seed is no longer
        // the current track.
        if (!s.playSimilarPref) return;
        if (s.index < 0 || s.queue[s.index]?.track.id !== seedId) return;
        // No embedding for the seed (or nothing similar) — leave it playing the
        // normal queue; the pref stays on so the next track retries.
        if (similar.length === 0) return;
        s.startSimilar(seedId, similar, history);
        pushRadioHistory(similar.map((t) => t.id));
      })
      .catch(() => {
        // Transient failure (offline downloaded track, etc.) — play normally.
        if (
          !cancelled &&
          usePlayerStore.getState().pendingSimilarSeed === seedId
        )
          usePlayerStore.getState()._clearPendingSimilar();
      });
    // A newer click (new pendingSimilarSeed) supersedes this fetch.
    return () => {
      cancelled = true;
    };
  }, [pendingSimilarSeed]);
}
