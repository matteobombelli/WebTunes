"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/stores/player";

const VOLUME_KEY = "wt-volume";
const PLAY_SIMILAR_KEY = "wt-play-similar";

export function usePlayerPreferences({
  initialNormalizeVolume,
  initialSimilarDrift,
  initialHideFriendDuplicates,
  volume,
  playSimilarPref,
}: {
  initialNormalizeVolume: boolean;
  initialSimilarDrift: boolean;
  initialHideFriendDuplicates: boolean;
  volume: number;
  playSimilarPref: boolean;
}): void {
  const volumeHydratedRef = useRef(false);
  const playSimilarHydratedRef = useRef(false);

  useEffect(() => {
    usePlayerStore.getState().setNormalizeVolume(initialNormalizeVolume);
  }, [initialNormalizeVolume]);

  useEffect(() => {
    usePlayerStore.getState().setSimilarDrift(initialSimilarDrift);
  }, [initialSimilarDrift]);

  useEffect(() => {
    usePlayerStore
      .getState()
      .setHideFriendDuplicates(initialHideFriendDuplicates);
  }, [initialHideFriendDuplicates]);

  useEffect(() => {
    const saved = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(saved) && saved >= 0 && saved <= 1) {
      usePlayerStore.getState().setVolume(saved);
    }
    volumeHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (volumeHydratedRef.current) {
      localStorage.setItem(VOLUME_KEY, String(volume));
    }
  }, [volume]);

  useEffect(() => {
    usePlayerStore
      .getState()
      .setPlaySimilarPref(localStorage.getItem(PLAY_SIMILAR_KEY) === "1");
    playSimilarHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!playSimilarHydratedRef.current) return;
    if (playSimilarPref) localStorage.setItem(PLAY_SIMILAR_KEY, "1");
    else localStorage.removeItem(PLAY_SIMILAR_KEY);
  }, [playSimilarPref]);
}
