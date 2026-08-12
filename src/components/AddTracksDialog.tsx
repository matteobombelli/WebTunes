"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO, TrackPageDTO } from "@/lib/types";
import { usePersistedScope, type Scope } from "@/lib/use-persisted-scope";
import { usePlayerStore } from "@/stores/player";
import Dialog from "@/components/Dialog";
import TrackArt from "@/components/TrackArt";
import MobileSwipeTrack from "@/components/MobileSwipeAction";
import {
  CheckIcon,
  GlobeIcon,
  LoaderIcon,
  MusicIcon,
  PlusIcon,
  UsersIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const TRACKS_PER_PAGE = 100;
const ADD_TRACK_EXIT_MS = 620;
const ADD_TRACK_SCOPES = [
  { value: "own", label: "Library", icon: <MusicIcon size={17} /> },
  { value: "all", label: "Everything", icon: <GlobeIcon size={17} /> },
  { value: "friends", label: "Friends", icon: <UsersIcon size={17} /> },
] as const;

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
  const router = useRouter();
  const changedRef = useRef(false);
  const close = () => {
    onClose();
    if (changedRef.current) {
      changedRef.current = false;
      router.refresh();
    }
  };

  return (
    <Dialog title="Add songs" open={open} onClose={close} wide>
      {open && (
        <AddTracksBody
          playlistId={playlistId}
          existingTrackIds={existingTrackIds}
          onAdded={() => {
            changedRef.current = true;
          }}
          onClose={close}
        />
      )}
    </Dialog>
  );
}

function AddTracksBody({
  playlistId,
  existingTrackIds,
  onAdded,
  onClose,
}: {
  playlistId: string;
  existingTrackIds: string[];
  onAdded: () => void;
  onClose: () => void;
}) {
  const [scope, setScope] = usePersistedScope("webtunes:library-scope");
  const [all, setAll] = useState<TrackPageDTO | null>(null);
  const [allScope, setAllScope] = useState<Scope | null>(null);
  const [searchResults, setSearchResults] = useState<TrackDTO[] | null>(null);
  const [searchKey, setSearchKey] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("");
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const addingIdsRef = useRef<Set<string>>(new Set());
  const exitTimersRef = useRef<number[]>([]);
  const currentTrackId = usePlayerStore((state) =>
    state.index >= 0 ? state.queue[state.index].track.id : null
  );
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  useEffect(() => {
    const controller = new AbortController();
    const scopeParam = scope === "own" ? "" : `scope=${scope}&`;
    api<TrackPageDTO>(`/tracks?${scopeParam}limit=${TRACKS_PER_PAGE}`, {
      signal: controller.signal,
    })
      .then((page) => {
        setAll(page);
        setAllScope(scope);
        setLoadFailed(false);
      })
      .catch(() => {
        // Distinguish "couldn't load" from "nothing to add".
        if (!controller.signal.aborted) {
          setAll({ tracks: [], totalCount: 0, nextCursor: null });
          setAllScope(scope);
          setLoadFailed(true);
        }
      });
    return () => controller.abort();
  }, [scope]);

  useEffect(
    () => () => {
      for (const timer of exitTimersRef.current) window.clearTimeout(timer);
    },
    []
  );

  const query = filter.trim();
  const activeSearchKey = `${scope}:${query}`;
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<TrackDTO[]>(
        `/search?q=${encodeURIComponent(query)}&scope=${scope}`,
        { signal: controller.signal }
      )
        .then((tracks) => {
          setSearchResults(tracks);
          setSearchKey(activeSearchKey);
          setLoadFailed(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchKey(activeSearchKey);
            setLoadFailed(true);
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeSearchKey, query, scope]);

  const loadMore = async () => {
    const cursor = allScope === scope ? all?.nextCursor : null;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const scopeParam = scope === "own" ? "" : `scope=${scope}&`;
      const next = await api<TrackPageDTO>(
        `/tracks?${scopeParam}limit=${TRACKS_PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
      );
      setAll((current) => {
        if (
          allScope !== scope ||
          !current ||
          current.nextCursor !== cursor
        ) {
          return current;
        }
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
      ? searchKey === activeSearchKey
        ? searchResults
        : null
      : allScope === scope
        ? (all?.tracks ?? null)
        : null;
    if (!source) return null;
    const existing = new Set(existingTrackIds);
    for (const id of removedIds) existing.add(id);
    // Search results are already filtered server-side, including lyric
    // matches. Re-filtering DTO fields here hid valid lyrics-only results.
    return source.filter((t) => !existing.has(t.id));
  }, [
    activeSearchKey,
    all,
    allScope,
    existingTrackIds,
    query,
    removedIds,
    scope,
    searchKey,
    searchResults,
  ]);

  const setAdding = (id: string, adding: boolean) => {
    setAddingIds((prev) => {
      const next = new Set(prev);
      if (adding) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const addTrack = async (track: TrackDTO) => {
    if (addingIdsRef.current.has(track.id)) return;
    addingIdsRef.current.add(track.id);
    setAdding(track.id, true);
    setError(null);
    try {
      await api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: track.id }),
      });
      setAddedIds((prev) => new Set(prev).add(track.id));
      onAdded();
      exitTimersRef.current.push(
        window.setTimeout(() => {
          setRemovedIds((prev) => new Set(prev).add(track.id));
        }, ADD_TRACK_EXIT_MS)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add track");
    } finally {
      addingIdsRef.current.delete(track.id);
      setAdding(track.id, false);
    }
  };

  const previewTrack = (track: TrackDTO) => {
    usePlayerStore.getState().playQueue([track], 0, {
      noAutoSimilar: true,
      startAtFraction: 0.4,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, artist, or album"
          className="min-w-52 flex-1"
        />
        <SegmentedControl
          options={ADD_TRACK_SCOPES}
          value={scope}
          onChange={setScope}
        />
      </div>
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
        {candidates?.map((t) => {
          const isCurrent = currentTrackId === t.id;
          const adding = addingIds.has(t.id);
          const added = addedIds.has(t.id);
          return (
            <div
              key={t.id}
              className={`overflow-hidden border-b border-border-subtle/60 last:border-b-0 ${
                added ? "animate-add-track-out" : ""
              }`}
            >
              <MobileSwipeTrack
                track={t}
                contentClassName="hover:bg-surface-2/40"
                surfaceClassName="bg-surface-1"
              >
                <div className="relative flex items-center gap-3 px-3 py-2 text-sm">
                  <button
                    type="button"
                    onClick={() => previewTrack(t)}
                    aria-label={`Preview ${t.title} from 40%`}
                    title={`Preview ${t.title} from 40%`}
                    className="absolute inset-0 z-0 rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
                  />
                  <div
                    aria-hidden
                    className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-3"
                  >
                    <TrackArt track={t} size="h-9 w-9" iconSize={16} thumb />
                    <span
                      className={`flex min-w-0 flex-1 items-center gap-1.5 font-medium ${
                        isCurrent ? "text-accent-bright" : ""
                      }`}
                    >
                      {isCurrent && (
                        <NowPlayingBars
                          playing={isPlaying}
                          className="h-3 w-3 shrink-0"
                        />
                      )}
                      <span className="truncate">{t.title}</span>
                    </span>
                    <span className="hidden max-w-32 truncate text-fg-muted sm:block">
                      {t.artist ?? "-"}
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {t.ownerName ?? "You"}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-swipe-ignore
                    onClick={() => void addTrack(t)}
                    disabled={adding || added}
                    aria-label={
                      added
                        ? `${t.title} added to playlist`
                        : `Add ${t.title} to playlist`
                    }
                    title={added ? "Added" : "Add to this playlist"}
                    className={`relative z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition disabled:pointer-events-none ${
                      added
                        ? "bg-green-500/15 text-green-400"
                        : "text-fg-muted hover:bg-surface-2 hover:text-accent-bright disabled:opacity-50"
                    }`}
                  >
                    {added ? (
                      <CheckIcon size={18} />
                    ) : adding ? (
                      <LoaderIcon size={18} className="animate-spin" />
                    ) : (
                      <PlusIcon size={18} />
                    )}
                  </button>
                </div>
              </MobileSwipeTrack>
            </div>
          );
        })}
        {!query && allScope === scope && all?.nextCursor && (
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
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
