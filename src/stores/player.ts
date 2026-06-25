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

/**
 * A queue slot: a track plus a stable id unique to this slot. The same track can
 * sit in the queue more than once, so `uid` (not `track.id`) is what the queue UI
 * keys/reorders by — otherwise duplicates collide and drag-reorder can't animate.
 */
export type QueueItem = { uid: string; track: TrackDTO };

let uidSeq = 0;
const wrap = (tracks: TrackDTO[]): QueueItem[] =>
  tracks.map((track) => ({ uid: `q${uidSeq++}`, track }));

type PlayerState = {
  queue: QueueItem[];
  index: number; // -1 when nothing is loaded
  /** Sticky across playQueue calls: new queues start shuffled too. */
  shuffled: boolean;
  /**
   * Pre-shuffle order, restored on unshuffle; null while shuffle is off.
   * Queue edits (add/remove) maintain both arrays, matching entries by
   * object reference — every mutation shares QueueItem references between them.
   */
  unshuffledQueue: QueueItem[] | null;
  /** "Play similar" radio is active: the queue auto-refills with tracks
   *  acoustically similar to a frozen seed (see usePlaySimilarRefill). */
  playSimilar: boolean;
  /** The seed track id similarity is ranked against; frozen when enabled. */
  similarSeedId: string | null;
  /** Ids already served this radio session (seed + every queued track), sent
   *  as the exclude list so refills don't repeat. */
  similarSeen: string[];
  /** Whether the settings modal is open (triggered from PlayerBar/MobileTopBar). */
  settingsOpen: boolean;
  isPlaying: boolean;
  volume: number; // 0..1
  /** When true, attenuate each track toward a common loudness target. */
  normalizeVolume: boolean;
  /** When true, "play similar" refills seed from the currently-playing track
   *  (the radio drifts); when false they stay anchored to similarSeedId. */
  similarDrift: boolean;
  /** Hide friends' tracks that duplicate one of the viewer's own (scope=all/
   *  friends + search). Shared with LibraryBrowser so the Settings toggle
   *  re-filters the visible list. */
  hideFriendDuplicates: boolean;
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
  /** Move a queue entry to a new position (drag-to-reorder). */
  reorder: (from: number, to: number) => void;
  toggleShuffle: () => void;
  /** Enable "play similar": keep the current track playing, replace the rest of
   *  the queue with the first batch of similar tracks, freeze the seed. */
  startSimilar: (seedId: string, tracks: TrackDTO[]) => void;
  /** Append the next refill batch and advance the pagination offset. */
  advanceSimilar: (tracks: TrackDTO[]) => void;
  /** Disable "play similar" (leaves the current queue intact). */
  stopSimilar: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setNormalizeVolume: (normalizeVolume: boolean) => void;
  setSimilarDrift: (similarDrift: boolean) => void;
  setHideFriendDuplicates: (hideFriendDuplicates: boolean) => void;

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
  playSimilar: false,
  similarSeedId: null,
  similarSeen: [],
  settingsOpen: false,
  isPlaying: false,
  volume: 1,
  normalizeVolume: true,
  similarDrift: true,
  hideFriendDuplicates: true,
  currentTime: 0,
  duration: 0,
  seekRequest: null,

  playQueue: (tracks, startIndex) => {
    const prev = get();
    // Starting a brand-new queue means the user picked new content — end any
    // "play similar" radio so it doesn't keep refilling from the old seed.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
    };
    const items = wrap(tracks);
    // Re-selecting the track that's already current won't change track?.id, so
    // PlayerBar's load effect won't refire — restart it with a seek to 0 so
    // clicking a song you're already playing starts it over.
    const prevCurrentId =
      prev.index >= 0 ? prev.queue[prev.index].track.id : null;
    const restart =
      prevCurrentId !== null && tracks[startIndex]?.id === prevCurrentId
        ? { seekRequest: 0 }
        : {};
    if (prev.shuffled && items.length > 0) {
      // Clicked track first, rest shuffled behind it.
      const rest = items.filter((_, i) => i !== startIndex);
      set({
        queue: [items[startIndex], ...shuffle(rest)],
        index: 0,
        unshuffledQueue: items,
        isPlaying: true,
        currentTime: 0,
        ...stopSim,
        ...restart,
      });
    } else {
      set({
        queue: items,
        index: startIndex,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: 0,
        ...stopSim,
        ...restart,
      });
    }
  },

  playAt: (index) => {
    const s = get();
    if (index < 0 || index >= s.queue.length) return;
    // Tapping the row that's already current restarts it: track?.id is
    // unchanged, so PlayerBar's load effect won't refire — seek to 0 instead.
    if (index === s.index) {
      set({ isPlaying: true, currentTime: 0, seekRequest: 0 });
      return;
    }
    set({ index, isPlaying: true, currentTime: 0 });
  },

  playNext: (tracks) => {
    const s = get();
    const items = wrap(tracks);
    if (s.index < 0) {
      // Nothing loaded: play the picked tracks as-is, even when shuffled.
      set({
        queue: items,
        index: 0,
        unshuffledQueue: s.shuffled ? items : null,
        isPlaying: true,
        currentTime: 0,
      });
      return;
    }
    const queue = [...s.queue];
    queue.splice(s.index + 1, 0, ...items);
    let unshuffledQueue = s.unshuffledQueue;
    if (unshuffledQueue) {
      unshuffledQueue = [...unshuffledQueue];
      unshuffledQueue.splice(
        unshuffledQueue.indexOf(s.queue[s.index]) + 1,
        0,
        ...items
      );
    }
    set({ queue, unshuffledQueue });
  },

  addToQueue: (tracks) => {
    const s = get();
    const items = wrap(tracks);
    if (s.index < 0) {
      set({
        queue: items,
        index: 0,
        unshuffledQueue: s.shuffled ? items : null,
        isPlaying: true,
        currentTime: 0,
      });
      return;
    }
    set({
      queue: [...s.queue, ...items],
      unshuffledQueue: s.unshuffledQueue
        ? [...s.unshuffledQueue, ...items]
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
      const kept = new Set<QueueItem>(queue);
      unshuffledQueue = unshuffledQueue.filter((t) => kept.has(t));
    }
    set({ queue, unshuffledQueue });
  },

  reorder: (from, to) => {
    const s = get();
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= s.queue.length ||
      to >= s.queue.length
    )
      return;
    // Track the current entry by reference so the now-playing pointer follows
    // its track to the new position. unshuffledQueue is left as the original
    // pre-shuffle order — a manual reorder is a transient arrangement of the
    // live queue, undone if shuffle is later turned off.
    const current = s.index >= 0 ? s.queue[s.index] : null;
    const queue = [...s.queue];
    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);
    set({ queue, index: current ? queue.indexOf(current) : s.index });
  },

  toggleShuffle: () => {
    const s = get();
    // Shuffle and "play similar" are mutually exclusive ways to order the
    // queue; turning shuffle on ends the radio.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
    };
    if (!s.shuffled) {
      if (s.index < 0) {
        set({ shuffled: true, ...stopSim });
        return;
      }
      const rest = s.queue.filter((_, i) => i !== s.index);
      set({
        shuffled: true,
        unshuffledQueue: s.queue,
        queue: [s.queue[s.index], ...shuffle(rest)],
        index: 0,
        ...stopSim,
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

  startSimilar: (seedId, tracks) => {
    const s = get();
    if (s.index < 0) return;
    // Keep the current track playing (don't reset isPlaying/currentTime); drop
    // the rest of the queue and seed it with the first similar batch.
    set({
      queue: [s.queue[s.index], ...wrap(tracks)],
      index: 0,
      shuffled: false,
      unshuffledQueue: null,
      playSimilar: true,
      similarSeedId: seedId,
      similarSeen: [seedId, ...tracks.map((t) => t.id)],
    });
  },

  advanceSimilar: (tracks) => {
    const s = get();
    if (!s.playSimilar) return;
    set({
      queue: [...s.queue, ...wrap(tracks)],
      similarSeen: [...s.similarSeen, ...tracks.map((t) => t.id)],
    });
  },

  stopSimilar: () =>
    set({ playSimilar: false, similarSeedId: null, similarSeen: [] }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

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
  setNormalizeVolume: (normalizeVolume) => set({ normalizeVolume }),
  setSimilarDrift: (similarDrift) => set({ similarDrift }),
  setHideFriendDuplicates: (hideFriendDuplicates) =>
    set({ hideFriendDuplicates }),

  _setProgress: (currentTime, duration) => set({ currentTime, duration }),
  _setPlaying: (isPlaying) => set({ isPlaying }),
  _clearSeek: () => set({ seekRequest: null }),
}));

export const useCurrentTrack = () =>
  usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index].track : null));
