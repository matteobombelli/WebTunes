"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import { usePlayerStore } from "@/stores/player";
import TrackList from "@/components/TrackList";
import {
  GlobeIcon,
  MusicIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from "@/components/icons";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const SCOPES = [
  { value: "own", label: "My library", icon: <MusicIcon size={17} /> },
  { value: "all", label: "Everything", icon: <GlobeIcon size={17} /> },
  { value: "friends", label: "Friends", icon: <UsersIcon size={17} /> },
] as const;

// Default view is the server-rendered own library (initialTracks, kept fresh
// by router.refresh from TrackList). Any query or non-own scope switches to
// client-fetched results.
export default function LibraryBrowser({
  initialTracks,
}: {
  initialTracks: TrackDTO[];
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = usePersistedScope("webtunes:library-scope");
  const [results, setResults] = useState<TrackDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Owned by the global Settings modal (player store); the server reads it per
  // request, so a change re-fires the fetch effect below to re-filter the list.
  const hideDuplicates = usePlayerStore((s) => s.hideFriendDuplicates);
  // Bumped after an edit/delete so client-fetched views re-query. Stable
  // identity ([] deps — setState is stable) so it doesn't defeat TrackRow's
  // React.memo by changing TrackList's `remove` callback every render.
  const [refreshKey, setRefreshKey] = useState(0);
  const onMutated = useCallback(() => setRefreshKey((k) => k + 1), []);

  const query = q.trim();
  const browsingOwn = !query && scope === "own";

  useEffect(() => {
    // Own-library browsing renders initialTracks; stale results are ignored.
    if (browsingOwn) return;
    // Abort superseded requests so a slow old response cannot win.
    const controller = new AbortController();
    const run = async () => {
      setSearching(true);
      try {
        let tracks: TrackDTO[];
        if (query) {
          tracks = await api<TrackDTO[]>(
            `/search?q=${encodeURIComponent(query)}&scope=${scope}`,
            { signal: controller.signal }
          );
        } else {
          // Browsing without a query: let the server return exactly this scope
          // (scope is "all" or "friends" here — "own" renders initialTracks),
          // so friends-only doesn't download own tracks just to discard them.
          tracks = await api<TrackDTO[]>(`/tracks?scope=${scope}`, {
            signal: controller.signal,
          });
        }
        setResults(tracks);
        setSearching(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setSearching(false);
        }
      }
    };
    // Debounce typing; scope switches fetch immediately.
    const timer = setTimeout(run, query ? 300 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, refreshKey, browsingOwn, hideDuplicates]);

  const tracks = browsingOwn ? initialTracks : results;
  const dimmed = !browsingOwn && searching;
  const countNoun = query ? "result" : "track";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, artist, album, or lyrics…"
            className="w-full pl-9 pr-9"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-white"
            >
              <XIcon size={16} />
            </button>
          )}
        </div>
        <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
      </div>

      {tracks === null ? (
        <p className="py-8 text-center text-sm text-fg-subtle">Loading…</p>
      ) : (
        // Keep stale results visible (dimmed) while a new fetch runs.
        <div
          className={`transition-opacity duration-100 ${dimmed ? "opacity-50" : ""}`}
        >
          <p className="mb-1 text-sm text-fg-muted">
            {tracks.length} {countNoun}
            {tracks.length === 1 ? "" : "s"}
          </p>
          <TrackList
            tracks={tracks}
            showOwner={!browsingOwn}
            canEdit
            canDelete
            selectable
            sortable
            onMutated={onMutated}
          />
        </div>
      )}
    </>
  );
}
