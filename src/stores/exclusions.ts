"use client";

import { create } from "zustand";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";

// Client mirror of the user's "exclude from Play Similar" list. UI-only: the
// kebab toggle reads `ids` for its label and the Settings sub-view reads
// `tracks`; the actual feed filter lives server-side in lib/similar.ts (the DB
// is the source of truth), so a stale store never leaks excluded tracks.
type ExclusionsState = {
  /** False until init() has loaded the list from the server. */
  ready: boolean;
  /** Track ids excluded from the viewer's Play Similar feed. */
  ids: Set<string>;
  /** Full DTOs of the excluded tracks, newest first (for the Settings list). */
  tracks: TrackDTO[];
  /** Loads the list once per app load. */
  init: () => Promise<void>;
  exclude: (track: TrackDTO) => Promise<void>;
  include: (trackId: string) => Promise<void>;
};

let initStarted = false;

export const useExclusionsStore = create<ExclusionsState>((set, get) => ({
  ready: false,
  ids: new Set(),
  tracks: [],

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    try {
      const { tracks } = await api<{ tracks: TrackDTO[] }>(
        "/similar-exclusions"
      );
      set({ tracks, ids: new Set(tracks.map((t) => t.id)), ready: true });
    } catch {
      // Best effort — leave the list empty; the server still filters the feed.
      set({ ready: true });
    }
  },

  exclude: async (track) => {
    const { ids, tracks } = get();
    if (ids.has(track.id)) return;
    // Optimistic: add to both, newest first to match the server ordering.
    set({ ids: new Set(ids).add(track.id), tracks: [track, ...tracks] });
    try {
      await api(`/tracks/${track.id}/similar-exclusion`, { method: "POST" });
    } catch {
      const ids = new Set(get().ids);
      ids.delete(track.id);
      set({ ids, tracks: get().tracks.filter((t) => t.id !== track.id) });
    }
  },

  include: async (trackId) => {
    const { ids, tracks } = get();
    if (!ids.has(trackId)) return;
    const removed = tracks.find((t) => t.id === trackId);
    const nextIds = new Set(ids);
    nextIds.delete(trackId);
    set({ ids: nextIds, tracks: tracks.filter((t) => t.id !== trackId) });
    try {
      await api(`/tracks/${trackId}/similar-exclusion`, { method: "DELETE" });
    } catch {
      // Restore both on failure.
      set({
        ids: new Set(get().ids).add(trackId),
        tracks: removed ? [removed, ...get().tracks] : get().tracks,
      });
    }
  },
}));

/** True when the track is in the viewer's Play Similar exclusion list. */
export function useIsExcluded(trackId: string): boolean {
  return useExclusionsStore((s) => s.ids.has(trackId));
}
