"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO, TrackPageDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import TrackArt from "@/components/TrackArt";
import MobileSwipeTrack from "@/components/MobileSwipeAction";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const TRACKS_PER_PAGE = 100;

// Stays mounted so the Dialog can animate out; the body mounts per open so
// the filter and selection start fresh each time.
export default function AddTracksDialog({
  playlistId,
  existingTrackIds,
  open,
  onClose,
}: {
  playlistId: string;
  existingTrackIds: string[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog title="Add songs" open={open} onClose={onClose} wide>
      {open && (
        <AddTracksBody
          playlistId={playlistId}
          existingTrackIds={existingTrackIds}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function AddTracksBody({
  playlistId,
  existingTrackIds,
  onClose,
}: {
  playlistId: string;
  existingTrackIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [all, setAll] = useState<TrackPageDTO | null>(null);
  const [searchResults, setSearchResults] = useState<TrackDTO[] | null>(null);
  const [searchKey, setSearchKey] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<TrackPageDTO>(`/tracks?scope=all&limit=${TRACKS_PER_PAGE}`, {
      signal: controller.signal,
    })
      .then((page) => {
        setAll(page);
        setLoadFailed(false);
      })
      .catch(() => {
        // Distinguish "couldn't load" from "nothing to add".
        if (!controller.signal.aborted) {
          setAll({ tracks: [], totalCount: 0, nextCursor: null });
          setLoadFailed(true);
        }
      });
    return () => controller.abort();
  }, []);

  const query = filter.trim();
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<TrackDTO[]>(
        `/search?q=${encodeURIComponent(query)}&scope=all`,
        { signal: controller.signal }
      )
        .then((tracks) => {
          setSearchResults(tracks);
          setSearchKey(query);
          setLoadFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchKey(query);
            setLoadFailed(true);
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const loadMore = async () => {
    const cursor = all?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api<TrackPageDTO>(
        `/tracks?scope=all&limit=${TRACKS_PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
      );
      setAll((current) => {
        if (!current || current.nextCursor !== cursor) return current;
        const ids = new Set(current.tracks.map((track) => track.id));
        return {
          tracks: [
            ...current.tracks,
            ...next.tracks.filter((track) => !ids.has(track.id)),
          ],
          totalCount: next.totalCount,
          nextCursor: next.nextCursor,
        };
      });
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const candidates = useMemo(() => {
    const source = query
      ? searchKey === query
        ? searchResults
        : null
      : all?.tracks ?? null;
    if (!source) return null;
    const existing = new Set(existingTrackIds);
    const f = query.toLowerCase();
    return source
      .filter((t) => !existing.has(t.id))
      .filter(
        (t) =>
          !f ||
          t.title.toLowerCase().includes(f) ||
          t.artist?.toLowerCase().includes(f) ||
          t.album?.toLowerCase().includes(f)
      );
  }, [all, existingTrackIds, query, searchKey, searchResults]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: [...selected] }),
      });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tracks");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by title, artist, or album"
      />
      <div className="max-h-80 overflow-y-auto rounded-md border border-border-subtle">
        {candidates === null && (
          <p className="p-4 text-sm text-fg-muted">Loading…</p>
        )}
        {candidates?.length === 0 && (
          <p className="p-4 text-sm text-fg-muted">
            {loadFailed
              ? "Couldn’t load your songs - check your connection."
              : "No more songs available to add."}
          </p>
        )}
        {candidates?.map((t) => (
          <MobileSwipeTrack
            key={t.id}
            track={t}
            className="border-b border-border-subtle/60 last:border-b-0"
            contentClassName="hover:bg-surface-2/40"
            surfaceClassName="bg-surface-1"
          >
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => toggle(t.id)}
                className="checkbox shrink-0"
              />
              <TrackArt track={t} size="h-9 w-9" iconSize={16} thumb />
              <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
              <span className="hidden max-w-32 truncate text-fg-muted sm:block">
                {t.artist ?? "-"}
              </span>
              <span className="shrink-0 text-xs text-fg-subtle">
                {t.ownerName ?? "You"}
              </span>
            </label>
          </MobileSwipeTrack>
        ))}
        {!query && all?.nextCursor && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full px-3 py-3 text-sm font-semibold text-accent hover:bg-surface-2/40 disabled:opacity-50"
          >
            {loadingMore ? "Loading more…" : "Load more songs"}
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={addSelected} disabled={busy || selected.size === 0}>
          {busy
            ? "Adding…"
            : `Add ${selected.size} song${selected.size === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}
