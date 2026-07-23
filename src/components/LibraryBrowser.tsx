"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO, TrackPageDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import { usePlayerStore } from "@/stores/player";
import TrackList from "@/components/TrackList";
import { SearchIcon, XIcon } from "@/components/icons";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TrackRowsSkeleton } from "@/components/ui/Skeleton";
import { SCOPES } from "@/components/ui/scopes";

// Session cache of the tracks loaded for each shared scope (+ the duplicate
// setting, which changes the server result). A cursor page renders first; the
// complete scope replaces it in the background and is restored on navigation.
const scopeCache = new Map<string, TrackPageDTO>();

const TRACKS_PER_PAGE = 100;

// Default view is the server-rendered first own-library page. Any query or
// non-own scope switches to client-fetched results; unfiltered lists fetch more
// pages only as their scroll sentinel approaches.
export default function LibraryBrowser({
  initialPage,
}: {
  initialPage: TrackPageDTO;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = usePersistedScope("webtunes:library-scope");
  const [results, setResults] = useState<TrackPageDTO | null>(null);
  // Changes only when a new first page lands, not when cursor/full results
  // extend it. It keeps complete-scope promises tied to the snapshot that
  // started them.
  const [resultsRevision, setResultsRevision] = useState(0);
  // Which view `results` belongs to, so a scope/query change can tell fresh
  // results from a previous view's (and fall back to the cache meanwhile).
  const [resultsKey, setResultsKey] = useState<string | null>(null);
  // The last fetch failed - its empty list means "couldn't load", not "empty".
  const [loadFailed, setLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Owned by the global Settings modal (player store); the server reads it per
  // request, so a change re-fires the fetch effect below to re-filter the list.
  const hideDuplicates = usePlayerStore((s) => s.hideFriendDuplicates);
  // Bumped after an edit/delete so client-fetched views re-query. Stable
  // identity ([] deps - setState is stable) so it doesn't defeat TrackRow's
  // React.memo by changing TrackList's `remove` callback every render.
  const [refreshKey, setRefreshKey] = useState(0);
  const onMutated = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Reset any loaded own-library tail when a server navigation or mutation
  // supplies a fresh first page.
  const [ownPage, setOwnPage] = useState(() => ({
    snapshot: initialPage,
    page: initialPage,
    revision: 0,
  }));
  if (ownPage.snapshot !== initialPage) {
    setOwnPage({
      snapshot: initialPage,
      page: initialPage,
      revision: ownPage.revision + 1,
    });
  }

  const query = q.trim();
  const browsingOwn = !query && scope === "own";
  const cacheKey = `${scope}:${hideDuplicates ? 1 : 0}`;
  const viewKey = query ? `q:${scope}:${query}` : cacheKey;
  const completeLoadKey = query
    ? null
    : `${viewKey}:${
        browsingOwn
          ? `own-${ownPage.revision}`
          : `remote-${resultsRevision}-refresh-${refreshKey}`
      }`;
  const activeCompleteLoadKeyRef = useRef(completeLoadKey);
  const completeLoadPromisesRef = useRef(
    new Map<string, Promise<TrackDTO[] | null>>()
  );

  useEffect(() => {
    activeCompleteLoadKeyRef.current = completeLoadKey;
  }, [completeLoadKey]);

  useEffect(() => {
    // Own-library browsing renders initialPage; stale results are ignored.
    if (browsingOwn) return;
    // Abort superseded requests so a slow old response cannot win.
    const controller = new AbortController();
    const run = async () => {
      setSearching(true);
      setLoadMoreFailed(false);
      try {
        let page: TrackPageDTO;
        if (query) {
          const tracks = await api<TrackDTO[]>(
            `/search?q=${encodeURIComponent(query)}&scope=${scope}`,
            { signal: controller.signal }
          );
          page = { tracks, totalCount: tracks.length, nextCursor: null };
        } else {
          // Browsing without a query: let the server return exactly this scope
          // (scope is "all" or "friends" here - "own" renders initialPage),
          // so friends-only doesn't download own tracks just to discard them.
          page = await api<TrackPageDTO>(
            `/tracks?scope=${scope}&limit=${TRACKS_PER_PAGE}`,
            { signal: controller.signal }
          );
        }
        if (!query) scopeCache.set(cacheKey, page);
        setResults(page);
        setResultsKey(viewKey);
        setResultsRevision((revision) => revision + 1);
        setLoadFailed(false);
        setSearching(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults({ tracks: [], totalCount: 0, nextCursor: null });
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
  // stale) - never the previous scope's misleading rows (skeleton instead).
  // Typing keeps the previous results visible, dimmed.
  const fresh = resultsKey === viewKey;
  const page = browsingOwn
    ? ownPage.page
    : fresh
      ? results
      : query
        ? results
        : (scopeCache.get(cacheKey) ?? null);
  const tracks = page?.tracks ?? null;
  const dimmed = !browsingOwn && searching && !fresh && !!query;
  const countNoun = query ? "result" : "track";
  const hasMore =
    !query && !!page?.nextCursor && (browsingOwn || (fresh && !searching));
  const trackCount = Math.max(page?.totalCount ?? 0, tracks?.length ?? 0);

  const appendPage = useCallback((current: TrackPageDTO, next: TrackPageDTO) => {
    const ids = new Set(current.tracks.map((track) => track.id));
    return {
      tracks: [
        ...current.tracks,
        ...next.tracks.filter((track) => !ids.has(track.id)),
      ],
      totalCount: next.totalCount,
      nextCursor: next.nextCursor,
    };
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const scopeParam = browsingOwn ? "" : `scope=${scope}&`;
      const next = await api<TrackPageDTO>(
        `/tracks?${scopeParam}limit=${TRACKS_PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
      );
      if (browsingOwn) {
        setOwnPage((current) =>
          current.page.nextCursor === cursor
            ? { ...current, page: appendPage(current.page, next) }
            : current
        );
      } else if (resultsKey === viewKey) {
        setResults((current) => {
          if (!current || current.nextCursor !== cursor) return current;
          const combined = appendPage(current, next);
          scopeCache.set(cacheKey, combined);
          return combined;
        });
      }
    } catch {
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [
    appendPage,
    browsingOwn,
    cacheKey,
    loadingMore,
    page?.nextCursor,
    resultsKey,
    scope,
    viewKey,
  ]);

  // Fetch the complete current scope once per first-page snapshot. The same
  // promise feeds background list completion, local sorting, and a queue that
  // started before completion, so those paths never duplicate the large pull.
  const loadCompleteCollection =
    useCallback((): Promise<TrackDTO[] | null> => {
      if (query || !page) return Promise.resolve(null);
      if (!page.nextCursor) return Promise.resolve(page.tracks);
      if (!completeLoadKey) return Promise.resolve(null);

      const existing = completeLoadPromisesRef.current.get(completeLoadKey);
      if (existing) return existing;

      const requestedLoadKey = completeLoadKey;
      const scopeParam = browsingOwn ? "" : `?scope=${scope}`;
      const task = (async () => {
        try {
          const allTracks = await api<TrackDTO[]>(`/tracks${scopeParam}`);
          const completePage: TrackPageDTO = {
            tracks: allTracks,
            totalCount: allTracks.length,
            nextCursor: null,
          };

          // Cache an inactive shared scope for an instant return visit, but
          // mutate visible state only when this exact snapshot is still active.
          if (!browsingOwn) scopeCache.set(cacheKey, completePage);
          if (activeCompleteLoadKeyRef.current === requestedLoadKey) {
            if (browsingOwn) {
              setOwnPage((current) => ({ ...current, page: completePage }));
            } else {
              setResults(completePage);
              setResultsKey(viewKey);
            }
          }
          return allTracks;
        } catch {
          // Allow a later sort/play action to retry. Ordinary background
          // completion is best-effort and deliberately has no visible error.
          completeLoadPromisesRef.current.delete(requestedLoadKey);
          return null;
        }
      })();
      completeLoadPromisesRef.current.set(requestedLoadKey, task);
      return task;
    }, [
      browsingOwn,
      cacheKey,
      completeLoadKey,
      page,
      query,
      scope,
      viewKey,
    ]);

  // Preserve the fast cursor-page paint, then backfill the complete scope in
  // the background. Cursor loading remains available while this request runs.
  useEffect(() => {
    if (!query && page?.nextCursor && (browsingOwn || fresh)) {
      void loadCompleteCollection();
    }
  }, [
    browsingOwn,
    fresh,
    loadCompleteCollection,
    page?.nextCursor,
    query,
  ]);

  // TrackList sorts locally, so an explicit sort waits for the shared complete
  // request. Unlike background playback completion, a failure keeps the
  // existing retry affordance visible.
  const prepareSort = useCallback(async (): Promise<boolean> => {
    if (query || !page?.nextCursor) return true;
    const requestedLoadKey = completeLoadKey;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const allTracks = await loadCompleteCollection();
      const stillActive =
        requestedLoadKey !== null &&
        activeCompleteLoadKeyRef.current === requestedLoadKey;
      if (!allTracks && stillActive) setLoadMoreFailed(true);
      return !!allTracks && stillActive;
    } finally {
      setLoadingMore(false);
    }
  }, [completeLoadKey, loadCompleteCollection, page?.nextCursor, query]);

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
            {trackCount}
            {" "}{countNoun}
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
            hasMore={hasMore && !loadMoreFailed}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            prepareSort={prepareSort}
            loadCompleteCollection={
              !query && page?.nextCursor
                ? loadCompleteCollection
                : undefined
            }
            emptyMessage={
              !browsingOwn && loadFailed && fresh
                ? "Couldn’t load tracks - check your connection."
                : query
                  ? `No matches for “${query}”.`
                  : undefined
            }
          />
          {loadMoreFailed && hasMore && (
            <div className="py-4 text-center text-sm text-fg-muted">
              Couldn’t load more tracks.{" "}
              <button
                type="button"
                onClick={loadMore}
                className="font-semibold text-accent hover:underline"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
