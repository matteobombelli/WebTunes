"use client";

import { create } from "zustand";
import { log } from "@/lib/log";
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
  /**
   * The live playback order: [played history, current, upcoming]. queue[0..index-1]
   * is the history of tracks ACTUALLY played; never-played tracks never live here.
   */
  queue: QueueItem[];
  index: number; // -1 when nothing is loaded
  /**
   * The full collection this session was started from (a playlist / library view),
   * as QueueItems — the SAME objects referenced in `queue`, so set-difference by
   * `uid` is exact even when a collection repeats a track. `null` for ad-hoc queues
   * (radio, manual edits, restored sessions). Shuffle draws every UNPLAYED track
   * from here (including the ones that sat before the clicked track and so were
   * never put in `queue`); unshuffle restores the in-order upcoming from it. The
   * key invariant it preserves: a never-played track is only ever in `context`,
   * never in `queue`'s history — so shuffling always reshuffles all of them.
   */
  context: QueueItem[] | null;
  /** Sticky across playQueue calls: new queues start shuffled too. */
  shuffled: boolean;
  /**
   * Pre-shuffle order, restored on unshuffle; null while shuffle is off. Only used
   * for ad-hoc (context-less) queues — context queues recompute order from
   * `context` instead. Entries are shared by object reference with `queue`.
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
  /** Remembered "play similar" preference (persisted to localStorage by
   *  PlayerBar). When on, playing a single track auto-starts a radio seeded from
   *  it. Cleared by the exceptions: enabling shuffle or playing a collection
   *  outright. Source of truth for the toggle button (distinct from the active
   *  `playSimilar` above, which can momentarily lag during the seed fetch). */
  playSimilarPref: boolean;
  /** Transient: a single-track play stamped this seed id to auto-start radio;
   *  consumed (and cleared) by usePlaySimilarAutoStart. null when nothing pends. */
  pendingSimilarSeed: string | null;
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

  /** Replace the queue and start playing. `collection` marks a "play outright"
   *  (playlist / discover mix): it skips the play-similar auto-start and clears
   *  the remembered preference. `noAutoSimilar` skips the auto-start without
   *  touching the preference — Discover uses it to start its own ephemeral radio
   *  (via startSimilar) with no double-fire. A single-track play (no opts) is
   *  radio-eligible. */
  playQueue: (
    tracks: TrackDTO[],
    startIndex: number,
    opts?: { collection?: boolean; noAutoSimilar?: boolean }
  ) => void;
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
  /** Set the remembered "play similar" preference (PlayerBar persists it). */
  setPlaySimilarPref: (on: boolean) => void;
  /** Clear the pending auto-start seed (consumed by usePlaySimilarAutoStart). */
  _clearPendingSimilar: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setNormalizeVolume: (normalizeVolume: boolean) => void;
  setSimilarDrift: (similarDrift: boolean) => void;
  setHideFriendDuplicates: (hideFriendDuplicates: boolean) => void;
  /** Restore a persisted session after an iOS page discard (always paused). */
  hydrateSession: (
    tracks: TrackDTO[],
    index: number,
    currentTime: number
  ) => void;

  // Setters owned by PlayerBar (the single <audio> element).
  _setProgress: (currentTime: number, duration: number) => void;
  _setPlaying: (isPlaying: boolean) => void;
  _clearSeek: () => void;
};

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  context: null,
  shuffled: false,
  unshuffledQueue: null,
  playSimilar: false,
  similarSeedId: null,
  similarSeen: [],
  playSimilarPref: false,
  pendingSimilarSeed: null,
  settingsOpen: false,
  isPlaying: false,
  volume: 1,
  normalizeVolume: true,
  similarDrift: true,
  hideFriendDuplicates: true,
  currentTime: 0,
  duration: 0,
  seekRequest: null,

  playQueue: (tracks, startIndex, opts) => {
    log.info(
      "player",
      `playQueue ${tracks.length} from #${startIndex}`,
      tracks[startIndex]?.title
    );
    const prev = get();
    // Starting a brand-new queue means the user picked new content — end any
    // "play similar" radio so it doesn't keep refilling from the old seed.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
    };
    // Remembered "play similar": a single-track play (no collection flag), with
    // the pref on and shuffle off, stamps a seed for usePlaySimilarAutoStart to
    // pick up. A collection play instead clears the pref (an exception).
    const autoSeed =
      !opts?.collection &&
      !opts?.noAutoSimilar &&
      prev.playSimilarPref &&
      !prev.shuffled
        ? tracks[startIndex]?.id ?? null
        : null;
    const prefReset = opts?.collection ? { playSimilarPref: false } : {};
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
      // Clicked track first, the rest of the collection shuffled behind it.
      // `context` holds the full collection (same QueueItems) so unshuffle can
      // restore the in-order continuation.
      const rest = items.filter((_, i) => i !== startIndex);
      set({
        queue: [items[startIndex], ...shuffle(rest)],
        index: 0,
        context: items,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: 0,
        ...stopSim,
        ...prefReset,
        pendingSimilarSeed: autoSeed,
        ...restart,
      });
    } else {
      // Start with no history: the clicked track is current and `queue` holds it
      // plus the in-order tracks after it. The tracks BEFORE it never enter
      // `queue` (so they can't become phantom history) — they live only in
      // `context`, where Shuffle can still reach them.
      set({
        queue: items.slice(startIndex),
        index: 0,
        context: items,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: 0,
        ...stopSim,
        ...prefReset,
        pendingSimilarSeed: autoSeed,
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
        context: null,
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
    // A hand-edited queue no longer matches its collection — drop the context so
    // Shuffle works on the actual queue (and can't silently drop these inserts).
    set({ queue, unshuffledQueue, context: null });
  },

  addToQueue: (tracks) => {
    const s = get();
    const items = wrap(tracks);
    if (s.index < 0) {
      set({
        queue: items,
        index: 0,
        context: null,
        unshuffledQueue: s.shuffled ? items : null,
        isPlaying: true,
        currentTime: 0,
      });
      return;
    }
    // See playNext: a hand-edited queue drops its context.
    set({
      queue: [...s.queue, ...items],
      unshuffledQueue: s.unshuffledQueue
        ? [...s.unshuffledQueue, ...items]
        : null,
      context: null,
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
      // Drop it from the context too so a later Shuffle doesn't re-add it.
      context: s.context
        ? s.context.filter((it) => it.uid !== removed.uid)
        : null,
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
    // Clearing upcoming means "empty" — drop the context so Shuffle doesn't
    // immediately repopulate it from the collection.
    set({ queue, unshuffledQueue, context: null });
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
    log.info("player", `shuffle ${!s.shuffled ? "on" : "off"}`);
    // Shuffle and "play similar" are mutually exclusive ways to order the
    // queue; turning shuffle on ends the radio.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
    };
    if (!s.shuffled) {
      // Enabling shuffle is an exception that clears the remembered "play
      // similar" preference (and any pending auto-start).
      const clearPref = { playSimilarPref: false, pendingSimilarSeed: null };
      if (s.index < 0) {
        set({ shuffled: true, ...stopSim, ...clearPref });
        return;
      }
      const history = s.queue.slice(0, s.index); // tracks ACTUALLY played
      const current = s.queue[s.index];
      if (s.context) {
        // Context queue: reshuffle EVERY unplayed track from the collection —
        // the ones still upcoming AND the ones that sat before the clicked track
        // (which only ever live in `context`). Keep history + current in place,
        // so a never-played track can never get stranded in history.
        const playedUids = new Set(history.map((it) => it.uid));
        const pool = s.context.filter(
          (it) => !playedUids.has(it.uid) && it.uid !== current.uid
        );
        set({
          shuffled: true,
          queue: [...history, current, ...shuffle(pool)],
          index: s.index,
          unshuffledQueue: null,
          ...stopSim,
          ...clearPref,
        });
      } else {
        // Ad-hoc queue (no collection): shuffle just the upcoming tail and save
        // the pre-shuffle order so unshuffle can restore it.
        const tail = s.queue.slice(s.index + 1);
        set({
          shuffled: true,
          unshuffledQueue: s.queue,
          queue: [...s.queue.slice(0, s.index + 1), ...shuffle(tail)],
          index: s.index,
          ...stopSim,
          ...clearPref,
        });
      }
    } else {
      if (s.index < 0) {
        set({ shuffled: false, unshuffledQueue: null });
        return;
      }
      const history = s.queue.slice(0, s.index);
      const current = s.queue[s.index];
      if (s.context) {
        // Restore the in-order continuation from the collection: the unplayed
        // tracks AFTER the current one, in collection order. Unplayed tracks
        // before it stay in `context` (reachable by Shuffle), never in history.
        const playedUids = new Set(history.map((it) => it.uid));
        const currentPos = s.context.findIndex((it) => it.uid === current.uid);
        const upcoming = (
          currentPos >= 0 ? s.context.slice(currentPos + 1) : s.context
        ).filter((it) => !playedUids.has(it.uid));
        set({
          shuffled: false,
          queue: [...history, current, ...upcoming],
          index: s.index,
          unshuffledQueue: null,
        });
      } else if (s.unshuffledQueue) {
        const restoredIndex = s.unshuffledQueue.indexOf(current);
        set({
          shuffled: false,
          queue: s.unshuffledQueue,
          index: restoredIndex >= 0 ? restoredIndex : 0,
          unshuffledQueue: null,
        });
      } else {
        set({ shuffled: false });
      }
    }
  },

  startSimilar: (seedId, tracks) => {
    const s = get();
    if (s.index < 0) return;
    log.info("player", `startSimilar seed=${seedId} +${tracks.length}`);
    // Keep the current track playing (don't reset isPlaying/currentTime); drop
    // the rest of the queue and seed it with the first similar batch.
    set({
      queue: [s.queue[s.index], ...wrap(tracks)],
      index: 0,
      context: null,
      shuffled: false,
      unshuffledQueue: null,
      playSimilar: true,
      similarSeedId: seedId,
      similarSeen: [seedId, ...tracks.map((t) => t.id)],
      pendingSimilarSeed: null,
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

  stopSimilar: () => {
    log.info("player", "stopSimilar");
    set({ playSimilar: false, similarSeedId: null, similarSeen: [] });
  },

  setPlaySimilarPref: (on) => set({ playSimilarPref: on }),

  _clearPendingSimilar: () => set({ pendingSimilarSeed: null }),

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
    // Restart the current track unless we're near its start. queue[0] is the
    // first real entry (never-played tracks live in `context`, not here), so the
    // floor is index 0.
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

  hydrateSession: (tracks, index, currentTime) =>
    // isPlaying MUST stay false: there is no user gesture at mount, and a
    // gesture-less play() would recreate the keep-alive AudioContext off-gesture
    // (BT-held-open/battery regression) and reject on iOS. The first tap resumes
    // via PlayerBar's in-gesture play path. Position is restored by PlayerBar's
    // onLoadedMetadata (not seekRequest, which the seek effect clears too early).
    // context stays null — the restored queue is treated as ad-hoc.
    set({ queue: wrap(tracks), index, context: null, isPlaying: false, currentTime }),

  _setProgress: (currentTime, duration) => set({ currentTime, duration }),
  _setPlaying: (isPlaying) => set({ isPlaying }),
  _clearSeek: () => set({ seekRequest: null }),
}));

export const useCurrentTrack = () =>
  usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index].track : null));
