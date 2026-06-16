"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import TrackList from "@/components/TrackList";
import { SearchIcon } from "@/components/icons";

const SCOPES = [
  { value: "own", label: "My library" },
  { value: "all", label: "Everything" },
  { value: "friends", label: "Friends" },
] as const;

// Default view is the server-rendered own library (initialTracks, kept fresh
// by router.refresh from TrackList). Any query or non-own scope switches to
// client-fetched results.
export default function LibraryBrowser({
  initialTracks,
  initialHideDuplicates,
}: {
  initialTracks: TrackDTO[];
  initialHideDuplicates: boolean;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = usePersistedScope("webtunes:library-scope");
  const [results, setResults] = useState<TrackDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [hideDuplicates, setHideDuplicates] = useState(initialHideDuplicates);
  // Bumped after an edit/delete so client-fetched views re-query.
  const [refreshKey, setRefreshKey] = useState(0);

  // The server reads the setting per request, so persist it first, then
  // refetch. Optimistic checkbox; reverted if the save fails.
  const toggleHideDuplicates = async (value: boolean) => {
    setHideDuplicates(value);
    try {
      await api("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideFriendDuplicates: value }),
      });
      setRefreshKey((k) => k + 1);
    } catch {
      setHideDuplicates(!value);
    }
  };

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
          // Browsing without a query: friends-only is the accessible set
          // minus own tracks (own tracks carry no ownerName).
          const all = await api<TrackDTO[]>("/tracks?scope=all", {
            signal: controller.signal,
          });
          tracks = scope === "friends" ? all.filter((t) => t.ownerName) : all;
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
  }, [query, scope, refreshKey, browsingOwn]);

  const tracks = browsingOwn ? initialTracks : results;
  const dimmed = !browsingOwn && searching;
  const countNoun = query ? "result" : "track";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, artist, album, or lyrics…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex rounded-md border border-neutral-700 text-sm">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              onClick={() => setScope(s.value)}
              className={`px-3 py-2 first:rounded-l-md last:rounded-r-md ${
                scope === s.value
                  ? "bg-emerald-600 text-white"
                  : "text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={hideDuplicates}
            onChange={(e) => toggleHideDuplicates(e.target.checked)}
            className="h-4 w-4 accent-emerald-600"
          />
          Hide duplicates from friends&apos; libraries
        </label>
      </div>

      {tracks === null ? (
        <p className="py-8 text-center text-sm text-neutral-500">Loading…</p>
      ) : (
        // Keep stale results visible (dimmed) while a new fetch runs.
        <div
          className={`transition-opacity duration-100 ${dimmed ? "opacity-50" : ""}`}
        >
          <p className="mb-2 text-sm text-neutral-400">
            {tracks.length} {countNoun}
            {tracks.length === 1 ? "" : "s"}
          </p>
          <TrackList
            tracks={tracks}
            showOwner={!browsingOwn}
            showPlays
            canEdit
            canDelete
            selectable
            sortable
            onMutated={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}
    </>
  );
}
