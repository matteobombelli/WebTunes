"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO } from "@/lib/types";
import { usePersistedScope } from "@/lib/use-persisted-scope";
import PlaylistCard from "@/components/PlaylistCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const SCOPES = [
  { value: "own", label: "My library" },
  { value: "all", label: "Everything" },
  { value: "friends", label: "Friends" },
] as const;

// Default view is the server-rendered own playlists (initialPlaylists). Any
// non-own scope switches to client-fetched results, mirroring LibraryBrowser.
export default function PlaylistBrowser({
  initialPlaylists,
}: {
  initialPlaylists: PlaylistDTO[];
}) {
  const [scope, setScope] = usePersistedScope("webtunes:playlists-scope");
  const [results, setResults] = useState<PlaylistDTO[] | null>(null);
  const [loading, setLoading] = useState(false);

  const browsingOwn = scope === "own";

  useEffect(() => {
    if (browsingOwn) return;
    // Abort superseded requests so a slow old response cannot win.
    const controller = new AbortController();
    const run = async () => {
      setLoading(true);
      try {
        // Friends-only is the accessible set minus own playlists (own playlists
        // carry no ownerName).
        const all = await api<PlaylistDTO[]>("/playlists?scope=all", {
          signal: controller.signal,
        });
        setResults(scope === "friends" ? all.filter((p) => p.ownerName) : all);
        setLoading(false);
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setLoading(false);
        }
      }
    };
    run();
    return () => controller.abort();
  }, [scope, browsingOwn]);

  const playlists = browsingOwn ? initialPlaylists : results;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl options={SCOPES} value={scope} onChange={setScope} />
      </div>

      {playlists === null ? (
        <p className="py-8 text-center text-sm text-fg-subtle">Loading…</p>
      ) : playlists.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-subtle">
          {browsingOwn
            ? "No playlists yet. Create one to organize your music."
            : "No playlists to show."}
        </p>
      ) : (
        // Keep stale results visible (dimmed) while a new fetch runs.
        <div
          className={`grid grid-cols-2 gap-4 transition-opacity duration-100 sm:grid-cols-3 lg:grid-cols-4 ${
            loading ? "opacity-50" : ""
          }`}
        >
          {playlists.map((p, i) => (
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
