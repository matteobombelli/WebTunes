"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import PlaylistCard from "@/components/PlaylistCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { SCOPES } from "@/components/ui/scopes";

// Session cache of the last successful accessible-playlists fetch, so scope
// switches render instantly and revalidate in the background (mirrors
// LibraryBrowser's scopeCache).
let cachedAllPlaylists: PlaylistDTO[] | null = null;

// Friends-only is the accessible set minus own playlists (own playlists carry
// no ownerName).
function forScope(all: PlaylistDTO[], scope: string): PlaylistDTO[] {
  return scope === "friends" ? all.filter((p) => p.ownerName) : all;
}

// Client-side orderings for the card grid; "recent" keeps the server's
// updatedAt order.
const PLAYLIST_SORTS = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "A–Z" },
  { value: "tracks", label: "Tracks" },
] as const;
type PlaylistSortKey = (typeof PLAYLIST_SORTS)[number]["value"];

function sortPlaylists(
  playlists: PlaylistDTO[],
  key: PlaylistSortKey
): PlaylistDTO[] {
  if (key === "recent") return playlists;
  const copy = [...playlists];
  if (key === "name") {
    copy.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  } else {
    copy.sort((a, b) => (b.trackCount ?? 0) - (a.trackCount ?? 0));
  }
  return copy;
}

// Default view is the server-rendered own playlists (initialPlaylists). Any
// non-own scope switches to client-fetched results, mirroring LibraryBrowser.
export default function PlaylistBrowser({
  initialPlaylists,
}: {
  initialPlaylists: PlaylistDTO[];
}) {
  const [scope, setScope] = usePersistedScope("webtunes:playlists-scope");
  const [sortKey, setSortKey] = useState<PlaylistSortKey>("recent");
  const [results, setResults] = useState<PlaylistDTO[] | null>(null);
  // Which scope `results` belongs to, so a scope change can tell fresh results
  // from the previous scope's (and fall back to the cache meanwhile).
  const [resultsKey, setResultsKey] = useState<string | null>(null);
  // The last fetch failed — its empty list means "couldn't load", not "empty".
  const [loadFailed, setLoadFailed] = useState(false);

  const browsingOwn = scope === "own";

  useEffect(() => {
    if (browsingOwn) return;
    // Abort superseded requests so a slow old response cannot win.
    const controller = new AbortController();
    const run = async () => {
      try {
        const all = await api<PlaylistDTO[]>("/playlists?scope=all", {
          signal: controller.signal,
        });
        cachedAllPlaylists = all;
        setResults(forScope(all, scope));
        setResultsKey(scope);
        setLoadFailed(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setResultsKey(scope);
          setLoadFailed(true);
        }
      }
    };
    run();
    return () => controller.abort();
  }, [scope, browsingOwn]);

  // Fresh results win; while a scope switch revalidates, the cached list
  // renders at full opacity, and an uncached scope shows the skeleton grid.
  const playlists = browsingOwn
    ? initialPlaylists
    : resultsKey === scope
      ? results
      : cachedAllPlaylists
        ? forScope(cachedAllPlaylists, scope)
        : null;
  const view = playlists ? sortPlaylists(playlists, sortKey) : null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
        <div className="ml-auto">
          <SegmentedControl
            options={PLAYLIST_SORTS}
            value={sortKey}
            onChange={setSortKey}
          />
        </div>
      </div>

      {view === null ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="aspect-square w-full rounded-md" />
              <Skeleton className="mt-2 h-4 w-3/4" />
              <Skeleton className="mt-1.5 h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : view.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">
          {!browsingOwn && loadFailed && resultsKey === scope
            ? "Couldn’t load playlists — check your connection."
            : browsingOwn
              ? "No playlists yet. Create one to organize your music."
              : "No playlists to show."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {view.map((p, i) => (
            <div
              key={p.id}
              className="animate-fade-in-up"
              style={{ animationDelay: `${Math.min(i, 8) * 0.03}s` }}
            >
              <PlaylistCard playlist={p} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
