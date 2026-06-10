"use client";

import { create } from "zustand";
import type { TrackDTO } from "@/lib/types";

type PlayerState = {
  queue: TrackDTO[];
  index: number; // -1 when nothing is loaded
  isPlaying: boolean;
  volume: number; // 0..1
  currentTime: number;
  duration: number;
  /** One-shot seek target consumed by PlayerBar's audio element. */
  seekRequest: number | null;

  playQueue: (tracks: TrackDTO[], startIndex: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;

  // Setters owned by PlayerBar (the single <audio> element).
  _setProgress: (currentTime: number, duration: number) => void;
  _setPlaying: (isPlaying: boolean) => void;
  _clearSeek: () => void;
};

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  seekRequest: null,

  playQueue: (tracks, startIndex) =>
    set({ queue: tracks, index: startIndex, isPlaying: true, currentTime: 0 }),

  toggle: () => {
    if (get().index >= 0) set((s) => ({ isPlaying: !s.isPlaying }));
  },

  next: () => {
    const s = get();
    if (s.index < 0) return;
    if (s.index + 1 < s.queue.length) {
      set({ index: s.index + 1, isPlaying: true, currentTime: 0 });
    } else {
      set({ isPlaying: false });
    }
  },

  prev: () => {
    const s = get();
    if (s.index < 0) return;
    // Restart the current track unless we're near its start.
    if (s.currentTime > 3 || s.index === 0) {
      set({ seekRequest: 0 });
    } else {
      set({ index: s.index - 1, isPlaying: true, currentTime: 0 });
    }
  },

  seekTo: (seconds) => set({ seekRequest: seconds }),
  setVolume: (volume) => set({ volume }),

  _setProgress: (currentTime, duration) => set({ currentTime, duration }),
  _setPlaying: (isPlaying) => set({ isPlaying }),
  _clearSeek: () => set({ seekRequest: null }),
}));

export const useCurrentTrack = () =>
  usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index] : null));
