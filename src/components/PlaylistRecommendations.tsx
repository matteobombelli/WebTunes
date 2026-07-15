"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import { useToastStore } from "@/stores/toast";
import { AddToPlaylistMenu } from "@/components/TrackMenus";
import TrackArt from "@/components/TrackArt";
import { PlusIcon, SimilarIcon } from "@/components/icons";

const LIMIT = 20;

/**
 * "Recommended" section under a playlist: tracks acoustically similar to the
 * playlist's own songs (the same multi-centroid recommender as Discover),
 * seeded per-playlist. Editors get a one-tap add-to-this-playlist button; other
 * viewers get the normal add-to-your-playlists menu. Hides itself entirely when
 * there's nothing to recommend (e.g. no member has an embedding yet).
 */
export default function PlaylistRecommendations({
  playlistId,
  canEdit,
}: {
  playlistId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const toast = useToastStore((s) => s.show);
  const [recs, setRecs] = useState<TrackDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  // Everything already surfaced (or added), so a refresh brings new tracks.
  const shownIds = useRef<Set<string>>(new Set());

  const fetchRecs = useCallback(async () => {
    const next = await api<TrackDTO[]>(`/playlists/${playlistId}/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: LIMIT, excludeIds: [...shownIds.current] }),
    });
    for (const t of next) shownIds.current.add(t.id);
    return next;
  }, [playlistId]);

  // Initial load: only sets state in the async continuation (never synchronously
  // in the effect body), guarded against a superseded playlist mount.
  useEffect(() => {
    let cancelled = false;
    fetchRecs()
      .then((next) => !cancelled && setRecs(next))
      .catch(() => !cancelled && setRecs((prev) => prev ?? []));
    return () => {
      cancelled = true;
    };
  }, [fetchRecs]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setRecs(await fetchRecs());
    } catch {
      setRecs((prev) => prev ?? []);
    } finally {
      setBusy(false);
    }
  };

  const addToPlaylist = async (track: TrackDTO) => {
    if (addingId) return;
    setAddingId(track.id);
    try {
      await api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: track.id }),
      });
      setRecs((prev) => prev?.filter((t) => t.id !== track.id) ?? null);
      toast(`Added “${track.title}”`);
      router.refresh(); // surface it in the playlist above
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn’t add track");
    } finally {
      setAddingId(null);
    }
  };

  // First load still running, or genuinely nothing to recommend → render nothing.
  if (recs === null || recs.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold tracking-tight">
            Recommended
          </h2>
          <p className="text-sm text-fg-muted">Based on this playlist’s songs</p>
        </div>
        <button
          onClick={refresh}
          disabled={busy}
          title="Refresh recommendations"
          className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg disabled:opacity-50"
        >
          <SimilarIcon size={16} />
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="divide-y divide-border-subtle/60 rounded-md border border-border-subtle">
        {recs.map((track, i) => (
          <div
            key={track.id}
            className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2/40"
          >
            <button
              onClick={() => playQueue(recs, i)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              title="Play"
            >
              <TrackArt track={track} size="h-9 w-9" iconSize={16} thumb />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{track.title}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {track.artist ?? "Unknown artist"}
                  {track.ownerName ? ` · ${track.ownerName}` : ""}
                </span>
              </span>
            </button>
            {canEdit ? (
              <button
                onClick={() => addToPlaylist(track)}
                disabled={addingId === track.id}
                title="Add to this playlist"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition hover:bg-surface-2 hover:text-accent-bright disabled:opacity-50"
              >
                <PlusIcon size={18} />
              </button>
            ) : (
              <AddToPlaylistMenu trackIds={[track.id]} floating />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
