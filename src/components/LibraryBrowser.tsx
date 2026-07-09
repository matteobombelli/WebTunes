"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import { usePlayerStore } from "@/stores/player";
import TrackList from "@/components/TrackList";
import { SearchIcon, XIcon } from "@/components/icons";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TrackRowsSkeleton } from "@/components/ui/Skeleton";
import { SCOPES } from "@/components/ui/scopes";

// Session cache of the last successful browse fetch per scope (+ the
// hideFriendDuplicates setting, which changes the server result). Module-level
// so it survives navigating away and back; the full list is a large JSON
// download, so a cached copy renders instantly while a background refetch
// revalidates it.
const scopeCache = new Map<string, TrackDTO[]>();

// scopeCache key for the background-fetched full own library (the own scope
// isn't affected by hideFriendDuplicates, so no setting suffix).
const OWN_FULL_KEY = "own:full";

// Default view is the server-rendered own library (initialTracks — only the
// newest slice at large library sizes, kept fresh by router.refresh from
// TrackList — with the remainder background-fetched below). Any query or
// non-own scope switches to client-fetched results.
export default function LibraryBrowser({
  initialTracks,
  totalTracks,
}: {
  initialTracks: TrackDTO[];
  /** How many tracks the user owns; > initialTracks.length means the server
   *  sent a partial slice and the full list must be fetched client-side. */
  totalTracks: number;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = usePersistedScope("webtunes:library-scope");
  const [results, setResults] = useState<TrackDTO[] | null>(null);
  // Which view `results` belongs to, so a scope/query change can tell fresh
  // results from a previous view's (and fall back to the cache meanwhile).
  const [resultsKey, setResultsKey] = useState<string | null>(null);
  // The last fetch failed — its empty list means "couldn't load", not "empty".
  const [loadFailed, setLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  // Owned by the global Settings modal (player store); the server reads it per
  // request, so a change re-fires the fetch effect below to re-filter the list.
  const hideDuplicates = usePlayerStore((s) => s.hideFriendDuplicates);
  // Bumped after an edit/delete so client-fetched views re-query. Stable
  // identity ([] deps — setState is stable) so it doesn't defeat TrackRow's
  // React.memo by changing TrackList's `remove` callback every render.
  const [refreshKey, setRefreshKey] = useState(0);
  const onMutated = useCallback(() => setRefreshKey((k) => k + 1), []);

  // The rest of the own library beyond the server's initial slice, fetched in
  // the background. Seeded from the module cache so navigating back renders the
  // full list instantly (revalidated below).
  const [ownFull, setOwnFull] = useState<TrackDTO[] | null>(
    () => scopeCache.get(OWN_FULL_KEY) ?? null
  );
  const initialPartial = initialTracks.length < totalTracks;
  useEffect(() => {
    if (!initialPartial) return;
    const controller = new AbortController();
    api<TrackDTO[]>("/tracks", { signal: controller.signal })
      .then((tracks) => {
        scopeCache.set(OWN_FULL_KEY, tracks);
        setOwnFull(tracks);
      })
      .catch(() => {}); // best-effort: the fresh initial slice stays up
    return () => controller.abort();
    // initialTracks identity marks a new server snapshot (a navigation, or the
    // router.refresh every mutation issues) — refetch so the tail can't go stale.
  }, [initialPartial, initialTracks]);

  // Own-scope list: the fresh server slice wins; the background-fetched list
  // fills in the older remainder (id-deduped — both are newest-first, and a
  // track outside the newest slice sorts after all of it, so concatenation
  // preserves order; a possibly-stale tail is corrected when the refetch lands).
  const ownTracks = useMemo(() => {
    if (!initialPartial || !ownFull) return initialTracks;
    const headIds = new Set(initialTracks.map((t) => t.id));
    return [...initialTracks, ...ownFull.filter((t) => !headIds.has(t.id))];
  }, [initialTracks, ownFull, initialPartial]);

  const query = q.trim();
  const browsingOwn = !query && scope === "own";
  const cacheKey = `${scope}:${hideDuplicates ? 1 : 0}`;
  const viewKey = query ? `q:${scope}:${query}` : cacheKey;

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
        if (!query) scopeCache.set(cacheKey, tracks);
        setResults(tracks);
        setResultsKey(viewKey);
        setLoadFailed(false);
        setSearching(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setResultsKey(viewKey);
          setLoadFailed(true);
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
  }, [query, scope, cacheKey, viewKey, refreshKey, browsingOwn]);

  // Precedence: fresh results win; while a scope switch revalidates, the
  // cached copy of THAT scope renders at full opacity (right data, maybe
  // stale) — never the previous scope's misleading rows (skeleton instead).
  // Typing keeps the previous results visible, dimmed.
  const fresh = resultsKey === viewKey;
  const tracks = browsingOwn
    ? ownTracks
    : fresh
      ? results
      : query
        ? results
        : (scopeCache.get(cacheKey) ?? null);
  const dimmed = !browsingOwn && searching && !fresh && !!query;
  const countNoun = query ? "result" : "track";
  // Own-scope count uses the server total so the partial first paint doesn't
  // briefly claim a slice-sized library while the full list is still loading.
  const trackCount = !tracks
    ? 0
    : browsingOwn
      ? Math.max(totalTracks, tracks.length)
      : tracks.length;

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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg"
            >
              <XIcon size={16} />
            </button>
          )}
        </div>
        <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
      </div>

      {tracks === null ? (
        <TrackRowsSkeleton />
      ) : (
        // Keep stale results visible (dimmed) while a new fetch runs.
        <div
          className={`transition-opacity duration-100 ${dimmed ? "opacity-50" : ""}`}
        >
          <p className="mb-1 text-sm text-fg-muted">
            {trackCount} {countNoun}
            {trackCount === 1 ? "" : "s"}
          </p>
          <TrackList
            tracks={tracks}
            showOwner={!browsingOwn}
            canEdit
            canDelete
            selectable
            sortable
            onMutated={onMutated}
            emptyMessage={
              !browsingOwn && loadFailed && fresh
                ? "Couldn’t load tracks — check your connection."
                : query
                  ? `No matches for “${query}”.`
                  : undefined
            }
          />
        </div>
      )}
    </>
  );
}
