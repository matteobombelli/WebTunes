"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import TrackList from "@/components/TrackList";

const SCOPES = [
  { value: "all", label: "Everything" },
  { value: "own", label: "My library" },
  { value: "friends", label: "Friends" },
] as const;

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<(typeof SCOPES)[number]["value"]>("all");
  const [results, setResults] = useState<TrackDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Bumped after an edit/delete so the results re-query.
  const [refreshKey, setRefreshKey] = useState(0);

  const query = q.trim();

  useEffect(() => {
    if (!query) return;
    // Abort superseded requests so a slow old search can't overwrite a new one.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const tracks = await api<TrackDTO[]>(
          `/search?q=${encodeURIComponent(query)}&scope=${scope}`,
          { signal: controller.signal }
        );
        setResults(tracks);
        setSearching(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setSearching(false);
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, refreshKey]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-2xl font-bold">Search</h1>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, artist, album, or lyrics…"
          className="w-full max-w-md rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm outline-none focus:border-emerald-500"
        />
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
      </div>

      {searching && results === null && (
        <p className="text-sm text-neutral-500">Searching…</p>
      )}
      {query && results !== null && (
        // Keep stale results visible (dimmed) while a new search runs.
        <div
          className={`transition-opacity duration-200 ${searching ? "opacity-50" : ""}`}
        >
          <p className="mb-2 text-sm text-neutral-400">
            {results.length} result{results.length === 1 ? "" : "s"}
          </p>
          <TrackList
            tracks={results}
            showOwner
            canEdit
            canDelete
            onMutated={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}
      {!query && (
        <p className="py-8 text-center text-sm text-neutral-500">
          Find songs across your library and your friends&apos; libraries, including
          lyrics search.
        </p>
      )}
    </div>
  );
}
