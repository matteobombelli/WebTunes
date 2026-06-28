"use client";

import { create } from "zustand";
import type { TrackDTO } from "@/lib/types";
import {
  getDownloadedPlaylists,
  getDownloadedTrack,
  getDownloadedTracks,
  type DownloadedPlaylist,
  type DownloadedTrack,
} from "@/lib/offline/db";
import * as offline from "@/lib/offline/downloads";

type QueueItem = { track: TrackDTO; pin: boolean };

type DownloadsState = {
  /** False until init() has hydrated from IndexedDB. */
  ready: boolean;
  tracks: Record<string, DownloadedTrack>;
  playlists: Record<string, DownloadedPlaylist>;
  /** Tracks waiting to download (excludes the one in flight). */
  queue: QueueItem[];
  current: { trackId: string; loaded: number; total: number } | null;
  storage: { usage: number; quota: number } | null;

  /** Hydrates from IndexedDB; when online also reconciles playlists. */
  init: () => Promise<void>;
  enqueue: (tracks: TrackDTO[], opts?: { pin?: boolean }) => void;
  downloadPlaylist: (playlistId: string) => Promise<void>;
  removeTrack: (trackId: string) => Promise<void>;
  removePlaylist: (playlistId: string) => Promise<void>;
  /** Wipes every download and clears the pending queue. */
  removeAll: () => Promise<void>;
  /** Account-switch purge: resets in-memory state and hard-clears all offline
   *  storage so the next user can't read the previous user's downloads. */
  purgeForAccountSwitch: () => Promise<void>;
};

export type DownloadStatus = "none" | "queued" | "downloading" | "downloaded";

let initStarted = false;
let processing = false;

async function requestPersistentStorage() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Best effort; the browser may still evict under pressure.
  }
}

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  // Refresh the storage-usage line out of band: it's display-only and
  // navigator.storage.estimate() can be slow, so it never blocks the metadata
  // update (or a user action waiting on refresh()).
  const updateStorage = async () => {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      set({ storage: { usage: usage ?? 0, quota: quota ?? 0 } });
    } catch {
      // Estimation unsupported; UI hides the usage line.
    }
  };

  const refresh = async () => {
    const [tracks, playlists] = await Promise.all([
      getDownloadedTracks(),
      getDownloadedPlaylists(),
    ]);
    set({
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      playlists: Object.fromEntries(playlists.map((p) => [p.id, p])),
    });
    void updateStorage();
  };

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        const [next, ...rest] = get().queue;
        if (!next) break;
        set({
          queue: rest,
          current: { trackId: next.track.id, loaded: 0, total: next.track.fileSize ?? 0 },
        });
        try {
          let lastReported = 0;
          await offline.downloadTrack(next.track, next.pin, (loaded, total) => {
            // Chunk callbacks are frequent; only re-render every ~256 KB.
            if (loaded - lastReported < 256 * 1024 && loaded !== total) return;
            lastReported = loaded;
            set({ current: { trackId: next.track.id, loaded, total } });
          });
          // Delta-merge just this track instead of re-reading all of IndexedDB
          // after every item (a 50-track playlist would otherwise do 50 full
          // scans). Playlists don't change here; storage updates once at drain.
          const rec = await getDownloadedTrack(next.track.id);
          if (rec) set((s) => ({ tracks: { ...s.tracks, [rec.id]: rec } }));
        } catch {
          // Skip the failed track and keep draining; it stays undownloaded
          // and the button returns to its download state.
        }
      }
    } finally {
      processing = false;
      set({ current: null });
      void updateStorage();
    }
  };

  return {
    ready: false,
    tracks: {},
    playlists: {},
    queue: [],
    current: null,
    storage: null,

    init: async () => {
      if (initStarted) return;
      initStarted = true;
      await refresh();
      set({ ready: true });
      if (navigator.onLine) {
        const toDownload = await offline.syncPlaylists();
        await refresh();
        if (toDownload.length > 0) get().enqueue(toDownload);
      }
    },

    enqueue: (tracks, opts) => {
      const pin = opts?.pin ?? false;
      const { queue, current, tracks: downloaded } = get();
      const pending = new Set(queue.map((q) => q.track.id));
      if (current) pending.add(current.trackId);
      const additions = tracks.filter(
        (t) => !pending.has(t.id) && !(downloaded[t.id] && !pin)
      );
      if (additions.length === 0) return;
      void requestPersistentStorage();
      set({ queue: [...queue, ...additions.map((track) => ({ track, pin }))] });
      void processQueue();
    },

    downloadPlaylist: async (playlistId) => {
      void requestPersistentStorage();
      const { toDownload } = await offline.downloadPlaylist(playlistId);
      await refresh();
      get().enqueue(toDownload);
    },

    removeTrack: async (trackId) => {
      await offline.removeTrack(trackId);
      await refresh();
    },

    removePlaylist: async (playlistId) => {
      await offline.removePlaylist(playlistId);
      await refresh();
    },

    removeAll: async () => {
      set({ queue: [] });
      await offline.removeAll();
      await refresh();
    },

    purgeForAccountSwitch: async () => {
      // Reset in-memory state synchronously so the UI can't flash the previous
      // user's downloads while the async storage clear runs.
      set({ tracks: {}, playlists: {}, queue: [], current: null, storage: null });
      await offline.purgeAllOfflineData();
    },
  };
});

export function useDownloadStatus(trackId: string): DownloadStatus {
  return useDownloadsStore((s) => {
    if (s.current?.trackId === trackId) return "downloading";
    if (s.queue.some((q) => q.track.id === trackId)) return "queued";
    if (s.tracks[trackId]) return "downloaded";
    return "none";
  });
}
