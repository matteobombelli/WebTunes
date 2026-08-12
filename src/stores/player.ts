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
 * keys/reorders by - otherwise duplicates collide and drag-reorder can't animate.
 */
export type QueueItem = { uid: string; track: TrackDTO };

let uidSeq = 0;
let collectionSessionSeq = 0;
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
   * as QueueItems - the SAME objects referenced in `queue`, so set-difference by
   * `uid` is exact even when a collection repeats a track. `null` for ad-hoc queues
   * (radio, manual edits, restored sessions). Shuffle draws every UNPLAYED track
   * from here (including the ones that sat before the clicked track and so were
   * never put in `queue`); unshuffle restores the in-order upcoming from it. The
   * key invariant it preserves: a never-played track is only ever in `context`,
   * never in `queue`'s history - so shuffling always reshuffles all of them.
   */
  context: QueueItem[] | null;
  /**
   * Identifies a collection that may still be expanded from a paginated
   * snapshot. Manual queue edits clear it so a late response cannot undo them.
   */
  collectionSession: number | null;
  /** Sticky across playQueue calls: new queues start shuffled too. */
  shuffled: boolean;
  /**
   * Pre-shuffle order, restored on unshuffle; null while shuffle is off. Only used
   * for ad-hoc (context-less) queues - context queues recompute order from
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
  /**
   * The collection `context` that was live when startSimilar replaced the
   * queue, plus the uid of the then-current item (one of `items` - `queue` and
   * `context` share QueueItem objects). Consumed by stopSimilar to append the
   * collection's in-order remainder after `afterUid`. Enabling shuffle restores
   * these items as the shuffle context instead of shuffling the radio results;
   * starting a new queue drops them. `null` when the radio started from an
   * ad-hoc queue.
   */
  similarContext: { items: QueueItem[]; afterUid: string } | null;
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
  /** Whether the tutorial tour overlay is open (auto-started on first visit by
   *  TutorialTour, replayable from the settings modal). */
  tutorialOpen: boolean;
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
  /** One-shot fractional start for a newly selected queue slot. PlayerBar uses
   *  the media fragment/retry path so fresh streamed loads honor it on iOS. */
  startAt: { uid: string; fraction: number } | null;

  /** Replace the queue and start playing. `collection` marks a "play outright"
   *  (playlist / discover mix): it skips the play-similar auto-start and clears
   *  the remembered preference. `noAutoSimilar` skips the auto-start without
   *  touching the preference - Discover uses it to start its own ephemeral radio
   *  (via startSimilar) with no double-fire. A single-track play (no opts) is
   *  radio-eligible. */
  playQueue: (
    tracks: TrackDTO[],
    startIndex: number,
    opts?: {
      collection?: boolean;
      noAutoSimilar?: boolean;
      startAtFraction?: number;
    }
  ) => number;
  /** Expand a paginated collection without restarting the playing track. */
  completeCollection: (session: number, tracks: TrackDTO[]) => void;
  /** Jump to a queue position (queue panel row click). */
  playAt: (index: number) => void;
  /** Insert right after the current track. */
  playNext: (tracks: TrackDTO[]) => void;
  /** Append to the end of the queue. */
  addToQueue: (tracks: TrackDTO[]) => void;
  /** Remove a non-current entry by queue position. */
  removeFromQueue: (index: number) => void;
  /** Remove every copy of a deleted track, advancing when it was current. */
  removeTrackEverywhere: (trackId: string) => void;
  /** Refresh metadata/privacy for every queued copy without changing order. */
  replaceTrackEverywhere: (track: TrackDTO) => void;
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
  /** Disable "play similar". Removes nothing from the queue; when the radio
   *  replaced a collection queue, the collection's in-order remainder (after
   *  the track the radio took over from) is appended to the end. */
  stopSimilar: () => void;
  /** Set the remembered "play similar" preference (PlayerBar persists it). */
  setPlaySimilarPref: (on: boolean) => void;
  /** Clear the pending auto-start seed (consumed by usePlaySimilarAutoStart). */
  _clearPendingSimilar: () => void;
  setSettingsOpen: (open: boolean) => void;
  setTutorialOpen: (open: boolean) => void;
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
  _clearStartAt: (uid: string) => void;
};

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  context: null,
  collectionSession: null,
  shuffled: false,
  unshuffledQueue: null,
  playSimilar: false,
  similarSeedId: null,
  similarSeen: [],
  similarContext: null,
  playSimilarPref: false,
  pendingSimilarSeed: null,
  settingsOpen: false,
  tutorialOpen: false,
  isPlaying: false,
  volume: 1,
  normalizeVolume: true,
  similarDrift: true,
  hideFriendDuplicates: true,
  currentTime: 0,
  duration: 0,
  seekRequest: null,
  startAt: null,

  playQueue: (tracks, startIndex, opts) => {
    log.info(
      "player",
      `playQueue ${tracks.length} from #${startIndex}`,
      tracks[startIndex]?.title
    );
    const prev = get();
    const collectionSession = ++collectionSessionSeq;
    // Starting a brand-new queue means the user picked new content - end any
    // "play similar" radio so it doesn't keep refilling from the old seed.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
      similarContext: null,
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
    const requestedFraction = opts?.startAtFraction;
    const startAt =
      requestedFraction != null && items[startIndex]
        ? {
            uid: items[startIndex].uid,
            fraction: Math.max(0, Math.min(1, requestedFraction)),
          }
        : null;
    const initialPosition =
      startAt && tracks[startIndex]?.durationSec != null
        ? tracks[startIndex].durationSec * startAt.fraction
        : 0;
    const initialDuration = tracks[startIndex]?.durationSec ?? 0;
    // Re-selecting the track that's already current won't change track?.id, so
    // PlayerBar's load effect won't refire - restart it with a seek to 0 so
    // clicking a song you're already playing starts it over.
    const prevCurrentId =
      prev.index >= 0 ? prev.queue[prev.index].track.id : null;
    const restart =
      startAt == null &&
      prevCurrentId !== null &&
      tracks[startIndex]?.id === prevCurrentId
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
        collectionSession,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: initialPosition,
        duration: initialDuration,
        seekRequest: null,
        startAt,
        ...stopSim,
        ...prefReset,
        pendingSimilarSeed: autoSeed,
        ...restart,
      });
    } else {
      // Start with no history: the clicked track is current and `queue` holds it
      // plus the in-order tracks after it. The tracks BEFORE it never enter
      // `queue` (so they can't become phantom history) - they live only in
      // `context`, where Shuffle can still reach them.
      set({
        queue: items.slice(startIndex),
        index: 0,
        context: items,
        collectionSession,
        unshuffledQueue: null,
        isPlaying: true,
        currentTime: initialPosition,
        duration: initialDuration,
        seekRequest: null,
        startAt,
        ...stopSim,
        ...prefReset,
        pendingSimilarSeed: autoSeed,
        ...restart,
      });
    }
    return collectionSession;
  },

  completeCollection: (session, tracks) => {
    const s = get();
    if (
      s.collectionSession !== session ||
      !s.context ||
      s.index < 0 ||
      !s.queue[s.index]
    ) {
      return;
    }

    // Reuse the original QueueItems so history/current retain their stable uid
    // and object identity. A response should only expand the active snapshot:
    // retain any original item absent from it as a stale-snapshot safety net.
    const byTrackId = new Map<string, QueueItem>();
    for (const item of s.context) byTrackId.set(item.track.id, item);
    for (const item of s.queue) {
      if (!byTrackId.has(item.track.id)) byTrackId.set(item.track.id, item);
    }
    const responseIds = new Set<string>();
    const completed = tracks.map((track) => {
      responseIds.add(track.id);
      return byTrackId.get(track.id) ?? wrap([track])[0];
    });
    const context = [
      ...completed,
      ...s.context.filter((item) => !responseIds.has(item.track.id)),
    ];

    const history = s.queue.slice(0, s.index);
    const current = s.queue[s.index];
    const playedUids = new Set(history.map((item) => item.uid));
    const pool = context.filter(
      (item) => !playedUids.has(item.uid) && item.uid !== current.uid
    );

    if (s.shuffled) {
      // The paginated slice supplied instant feedback. Once complete, give all
      // still-unplayed tracks a fair shuffle while history/current stay fixed.
      set({
        queue: [...history, current, ...shuffle(pool)],
        index: s.index,
        context,
        collectionSession: null,
        unshuffledQueue: null,
      });
      return;
    }

    // Restore the complete in-order continuation after the current track.
    // Tracks before it remain context-only rather than becoming fake history.
    const currentPos = context.findIndex((item) => item.uid === current.uid);
    const upcoming = (
      currentPos >= 0 ? context.slice(currentPos + 1) : pool
    ).filter((item) => !playedUids.has(item.uid));
    set({
      queue: [...history, current, ...upcoming],
      index: s.index,
      context,
      collectionSession: null,
      unshuffledQueue: null,
    });
  },

  playAt: (index) => {
    const s = get();
    if (index < 0 || index >= s.queue.length) return;
    // Tapping the row that's already current restarts it: track?.id is
    // unchanged, so PlayerBar's load effect won't refire - seek to 0 instead.
    if (index === s.index) {
      set({ isPlaying: true, currentTime: 0, seekRequest: 0 });
      return;
    }
    set({
      index,
      isPlaying: true,
      currentTime: 0,
      duration: s.queue[index].track.durationSec ?? 0,
    });
  },

  playNext: (tracks) => {
    if (tracks.length === 0) return;
    const s = get();
    const items = wrap(tracks);
    if (s.index < 0) {
      // Nothing loaded: play the picked tracks as-is, even when shuffled.
      set({
        queue: items,
        index: 0,
        context: null,
        collectionSession: null,
        unshuffledQueue: s.shuffled ? items : null,
        isPlaying: true,
        currentTime: 0,
        duration: tracks[0].durationSec ?? 0,
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
    // A hand-edited queue no longer matches its collection - drop the context so
    // Shuffle works on the actual queue (and can't silently drop these inserts).
    set({ queue, unshuffledQueue, context: null, collectionSession: null });
  },

  addToQueue: (tracks) => {
    // An empty add must not take the "nothing loaded" branch: queue [] with
    // index 0 would make every queue[index].track selector throw.
    if (tracks.length === 0) return;
    const s = get();
    const items = wrap(tracks);
    if (s.index < 0) {
      set({
        queue: items,
        index: 0,
        context: null,
        collectionSession: null,
        unshuffledQueue: s.shuffled ? items : null,
        isPlaying: true,
        currentTime: 0,
        duration: tracks[0].durationSec ?? 0,
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
      collectionSession: null,
    });
  },

  removeFromQueue: (index) => {
    const s = get();
    // The current track can't be removed (skip it instead) - allowing it
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
      collectionSession: null,
    });
  },

  removeTrackEverywhere: (trackId) => {
    const s = get();
    if (!s.queue.some((item) => item.track.id === trackId)) return;
    const currentWasRemoved =
      s.index >= 0 && s.queue[s.index]?.track.id === trackId;
    const before = s.queue
      .slice(0, Math.max(0, s.index))
      .filter((item) => item.track.id !== trackId);
    const after = s.queue
      .slice(Math.max(0, s.index + 1))
      .filter((item) => item.track.id !== trackId);
    const context = s.context?.filter((item) => item.track.id !== trackId) ?? null;
    const unshuffledQueue =
      s.unshuffledQueue?.filter((item) => item.track.id !== trackId) ?? null;
    if (currentWasRemoved) {
      if (!after.length) {
        set({
          queue: [],
          index: -1,
          context: null,
          collectionSession: null,
          unshuffledQueue: null,
          isPlaying: false,
          currentTime: 0,
          duration: 0,
        });
      } else {
        set({
          queue: [...before, ...after],
          index: before.length,
          context,
          collectionSession: null,
          unshuffledQueue,
          isPlaying: true,
          currentTime: 0,
          duration: after[0].track.durationSec ?? 0,
        });
      }
      return;
    }
    const queue = s.queue.filter((item) => item.track.id !== trackId);
    const removedBefore = s.queue
      .slice(0, Math.max(0, s.index))
      .filter((item) => item.track.id === trackId).length;
    set({
      queue,
      index: s.index - removedBefore,
      context,
      collectionSession: null,
      unshuffledQueue,
    });
  },

  replaceTrackEverywhere: (track) => {
    const s = get();
    const replacements = new Map<string, QueueItem>();
    const replace = (item: QueueItem) => {
      if (item.track.id !== track.id) return item;
      let next = replacements.get(item.uid);
      if (!next) {
        next = { ...item, track };
        replacements.set(item.uid, next);
      }
      return next;
    };
    set({
      queue: s.queue.map(replace),
      context: s.context?.map(replace) ?? null,
      unshuffledQueue: s.unshuffledQueue?.map(replace) ?? null,
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
    // Clearing upcoming means "empty" - drop the context so Shuffle doesn't
    // immediately repopulate it from the collection.
    set({ queue, unshuffledQueue, context: null, collectionSession: null });
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
    // pre-shuffle order - a manual reorder is a transient arrangement of the
    // live queue, undone if shuffle is later turned off.
    const current = s.index >= 0 ? s.queue[s.index] : null;
    const queue = [...s.queue];
    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);
    set({
      queue,
      index: current ? queue.indexOf(current) : s.index,
      collectionSession: null,
    });
  },

  toggleShuffle: () => {
    const s = get();
    log.info("player", `shuffle ${!s.shuffled ? "on" : "off"}`);
    // Shuffle and "play similar" are mutually exclusive ways to order tracks;
    // turning shuffle on ends the radio. A stashed collection is handled below
    // before stopSim clears the stash.
    const stopSim = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
      similarContext: null,
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
      if (s.playSimilar && s.similarContext) {
        // Switching straight from radio to shuffle means "shuffle the collection
        // I came from", not "shuffle these generated radio results". Preserve
        // actual history/current playback, discard unplayed radio results, and
        // restore every still-unplayed item from the stashed collection as the
        // shuffle pool. If radio has already advanced to a generated track, put
        // that current slot at the front of context so turning shuffle off later
        // can continue into the original collection in order.
        const collection = s.similarContext.items;
        const context = collection.some((it) => it.uid === current.uid)
          ? collection
          : [current, ...collection];
        const playedUids = new Set(history.map((it) => it.uid));
        const pool = context.filter(
          (it) => !playedUids.has(it.uid) && it.uid !== current.uid
        );
        set({
          shuffled: true,
          queue: [...history, current, ...shuffle(pool)],
          index: s.index,
          context,
          collectionSession: null,
          unshuffledQueue: null,
          ...stopSim,
          ...clearPref,
        });
      } else if (s.context) {
        // Context queue: reshuffle EVERY unplayed track from the collection -
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
    // the rest of the queue and seed it with the first similar batch. The
    // outgoing collection context is stashed so stopSimilar can append its
    // in-order remainder (when context is set, the current item is always one
    // of its objects - hand-edits null the context).
    set({
      queue: [s.queue[s.index], ...wrap(tracks)],
      index: 0,
      context: null,
      collectionSession: null,
      shuffled: false,
      unshuffledQueue: null,
      playSimilar: true,
      similarSeedId: seedId,
      similarSeen: [seedId, ...tracks.map((t) => t.id)],
      similarContext: s.context
        ? { items: s.context, afterUid: s.queue[s.index].uid }
        : null,
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
    const s = get();
    const off = {
      playSimilar: false,
      similarSeedId: null,
      similarSeen: [],
      similarContext: null,
    };
    if (!s.playSimilar || !s.similarContext) {
      set(off);
      return;
    }
    // Remove nothing: the served similar tracks (and any manual inserts) stay;
    // the collection's remainder after the takeover point resumes at the end.
    const { items, afterUid } = s.similarContext;
    const pos = items.findIndex((it) => it.uid === afterUid);
    const remainder = pos >= 0 ? items.slice(pos + 1) : [];
    set({ ...off, queue: [...s.queue, ...remainder] });
  },

  setPlaySimilarPref: (on) => set({ playSimilarPref: on }),

  _clearPendingSimilar: () => set({ pendingSimilarSeed: null }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setTutorialOpen: (open) => set({ tutorialOpen: open }),

  toggle: () => {
    if (get().index >= 0) set((s) => ({ isPlaying: !s.isPlaying }));
  },

  next: () => {
    const s = get();
    if (s.index < 0) return;
    if (s.index + 1 < s.queue.length) {
      set({
        index: s.index + 1,
        isPlaying: true,
        currentTime: 0,
        duration: s.queue[s.index + 1].track.durationSec ?? 0,
      });
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
      set({
        index: s.index - 1,
        isPlaying: true,
        currentTime: 0,
        duration: s.queue[s.index - 1].track.durationSec ?? 0,
      });
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
    // context stays null - the restored queue is treated as ad-hoc.
    set({
      queue: wrap(tracks),
      index,
      context: null,
      collectionSession: null,
      isPlaying: false,
      currentTime,
      duration: tracks[index]?.durationSec ?? 0,
    }),

  _setProgress: (currentTime, duration) => set({ currentTime, duration }),
  _setPlaying: (isPlaying) => set({ isPlaying }),
  _clearSeek: () => set({ seekRequest: null }),
  _clearStartAt: (uid) =>
    set((state) => ({
      startAt: state.startAt?.uid === uid ? null : state.startAt,
    })),
}));

export const useCurrentTrack = () =>
  usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index].track : null));
