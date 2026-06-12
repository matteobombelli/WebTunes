"use client";

import { create } from "zustand";
import type { TrackDTO } from "@/lib/types";
import {
  getDownloadedPlaylists,
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
  const refresh = async () => {
    const [tracks, playlists] = await Promise.all([
      getDownloadedTracks(),
      getDownloadedPlaylists(),
    ]);
    let storage: DownloadsState["storage"] = null;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storage = { usage: usage ?? 0, quota: quota ?? 0 };
    } catch {
      // Estimation unsupported; UI hides the usage line.
    }
    set({
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      playlists: Object.fromEntries(playlists.map((p) => [p.id, p])),
      storage,
    });
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
        } catch {
          // Skip the failed track and keep draining; it stays undownloaded
          // and the button returns to its download state.
        }
        await refresh();
      }
    } finally {
      processing = false;
      set({ current: null });
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
