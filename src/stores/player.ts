"use client";

import { create } from "zustand";
import type { TrackDTO } from "@/lib/types";

/** Fisher-Yates; returns a new array. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

type PlayerState = {
  queue: TrackDTO[];
  index: number; // -1 when nothing is loaded
  /** Sticky across playQueue calls: new queues start shuffled too. */
  shuffled: boolean;
  /**
   * Pre-shuffle order, restored on unshuffle; null while shuffle is off.
   * Queue edits (add/remove) maintain both arrays, matching entries by
   * object reference — every mutation shares track references between them.
   */
  unshuffledQueue: TrackDTO[] | null;
  isPlaying: boolean;
  volume: number; // 0..1
  currentTime: number;
  duration: number;
  /** One-shot seek target consumed by PlayerBar's audio element. */
  seekRequest: number | null;

  playQueue: (tracks: TrackDTO[], startIndex: number) => void;
  /** Jump to a queue position (queue panel row click). */
  playAt: (index: number) => void;
  /** Insert right after the current track. */
  playNext: (tracks: TrackDTO[]) => void;
  /** Append to the end of the queue. */
  addToQueue: (tracks: TrackDTO[]) => void;
  /** Remove a non-current entry by queue position. */
  removeFromQueue: (index: number) => void;
  /** Drop everything after the current track. */
  clearUpcoming: () => void;
  toggleShuffle: () => void;
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
  shuffled: false,
  unshuffledQueue: null,
  isPlaying: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  seekRequest: null,

  playQueue: (tracks, startIndex) => {
    if (get().shuffled && tracks.length > 0) {
      // Clicked track first, rest shuffled behind it.
      const rest = tracks.filter((_, i) => i !== startIndex);
      set({
        queue: [tracks[startIndex], ...shuffle(rest)],
        index: 0,
        unshuffledQueue: tracks,
        isPlaying: true,
        currentTime: 0,
      });
    } else {
      set({
        queue: tracks,
        index: startIndex,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: 0,
      });
    }
  },

  playAt: (index) => {
    const s = get();
    if (index < 0 || index >= s.queue.length || index === s.index) return;
    set({ index, isPlaying: true, currentTime: 0 });
  },

  playNext: (tracks) => {
    const s = get();
    if (s.index < 0) {
      // Nothing loaded: play the picked tracks as-is, even when shuffled.
      set({
        queue: tracks,
        index: 0,
        unshuffledQueue: s.shuffled ? tracks : null,
        isPlaying: true,
        currentTime: 0,
      });
      return;
    }
    const queue = [...s.queue];
    queue.splice(s.index + 1, 0, ...tracks);
    let unshuffledQueue = s.unshuffledQueue;
    if (unshuffledQueue) {
      unshuffledQueue = [...unshuffledQueue];
      unshuffledQueue.splice(
        unshuffledQueue.indexOf(s.queue[s.index]) + 1,
        0,
        ...tracks
      );
    }
    set({ queue, unshuffledQueue });
  },

  addToQueue: (tracks) => {
    const s = get();
    if (s.index < 0) {
      set({
        queue: tracks,
        index: 0,
        unshuffledQueue: s.shuffled ? tracks : null,
        isPlaying: true,
        currentTime: 0,
      });
      return;
    }
    set({
      queue: [...s.queue, ...tracks],
      unshuffledQueue: s.unshuffledQueue
        ? [...s.unshuffledQueue, ...tracks]
        : null,
    });
  },

  removeFromQueue: (index) => {
    const s = get();
    // The current track can't be removed (skip it instead) — allowing it
    // would leave the player with no defensible "current" entry.
    if (index < 0 || index >= s.queue.length || index === s.index) return;
    const removed = s.queue[index];
    let unshuffledQueue = s.unshuffledQueue;
    if (unshuffledQueue) {
      const pos = unshuffledQueue.indexOf(removed);
      unshuffledQueue = unshuffledQueue.filter((_, i) => i !== pos);
    }
    set({
      queue: s.queue.filter((_, i) => i !== index),
      unshuffledQueue,
      index: index < s.index ? s.index - 1 : s.index,
    });
  },

  clearUpcoming: () => {
    const s = get();
    if (s.index < 0) return;
    const queue = s.queue.slice(0, s.index + 1);
    let unshuffledQueue = s.unshuffledQueue;
    if (unshuffledQueue) {
      const kept = new Set<TrackDTO>(queue);
      unshuffledQueue = unshuffledQueue.filter((t) => kept.has(t));
    }
    set({ queue, unshuffledQueue });
  },

  toggleShuffle: () => {
    const s = get();
    if (!s.shuffled) {
      if (s.index < 0) {
        set({ shuffled: true });
        return;
      }
      const rest = s.queue.filter((_, i) => i !== s.index);
      set({
        shuffled: true,
        unshuffledQueue: s.queue,
        queue: [s.queue[s.index], ...shuffle(rest)],
        index: 0,
      });
    } else {
      if (s.index < 0 || !s.unshuffledQueue) {
        set({ shuffled: false, unshuffledQueue: null });
        return;
      }
      const restoredIndex = s.unshuffledQueue.indexOf(s.queue[s.index]);
      set({
        shuffled: false,
        queue: s.unshuffledQueue,
        index: restoredIndex >= 0 ? restoredIndex : 0,
        unshuffledQueue: null,
      });
    }
  },

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
