"use client";

import { useEffect } from "react";
import type { DownloadedPlaylist, DownloadedTrack } from "@/lib/offline/db";
import { useDownloadsStore } from "@/stores/downloads";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import { DownloadIcon, XIcon } from "@/components/icons";

// The offline workhorse: everything rendered here comes from the downloads
// store (IndexedDB) — no server data, no API-dependent actions. TrackList is
// deliberately not reused; its row actions (edit, add-to-playlist,
// router.refresh) all assume a network.

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function TrackRows({
  tracks,
  onRemove,
}: {
  tracks: DownloadedTrack[];
  onRemove?: (track: DownloadedTrack) => void;
}) {
  const playQueue = usePlayerStore((s) => s.playQueue);
  const current = useCurrentTrack();
  return (
    <ul className="divide-y divide-neutral-800/60">
      {tracks.map((track, i) => (
        <li
          key={track.id}
          className={`group flex items-center gap-3 py-2 ${
            current?.id === track.id ? "text-emerald-400" : "text-neutral-200"
          }`}
        >
          <button
            onClick={() => playQueue(tracks, i)}
            title={`Play ${track.title}`}
            className="min-w-0 flex-1 text-left hover:text-emerald-400"
          >
            <p className="truncate text-sm font-medium">{track.title}</p>
            <p className="truncate text-xs text-neutral-400">
              {track.artist ?? "Unknown artist"}
              {track.ownerName ? ` · from ${track.ownerName}` : ""}
            </p>
          </button>
          {track.fileSize !== null && (
            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
              {formatBytes(track.fileSize)}
            </span>
          )}
          {onRemove && (
            <button
              onClick={() => onRemove(track)}
              aria-label="Remove download"
              title="Remove download"
              className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-red-400"
            >
              <XIcon size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlaylistSection({ playlist }: { playlist: DownloadedPlaylist }) {
  const tracksById = useDownloadsStore((s) => s.tracks);
  const removePlaylist = useDownloadsStore((s) => s.removePlaylist);
  // Only members whose audio is on the device; the rest are still queued or
  // failed and will arrive on a later online sync.
  const tracks = playlist.trackIds
    .map((id) => tracksById[id])
    .filter((t): t is DownloadedTrack => t !== undefined);
  return (
    <section className="mb-8">
      <div className="mb-1 flex items-center gap-3">
        <h2 className="truncate text-lg font-semibold">{playlist.name}</h2>
        <span className="text-xs text-neutral-500">
          {tracks.length}/{playlist.trackIds.length} downloaded
        </span>
        <button
          onClick={() => {
            if (confirm(`Remove "${playlist.name}" from downloads?`)) {
              void removePlaylist(playlist.id);
            }
          }}
          className="ml-auto shrink-0 text-xs text-neutral-400 hover:text-red-400"
        >
          Remove
        </button>
      </div>
      <TrackRows tracks={tracks} />
    </section>
  );
}

export default function DownloadsBrowser() {
  const ready = useDownloadsStore((s) => s.ready);
  const tracksById = useDownloadsStore((s) => s.tracks);
  const playlistsById = useDownloadsStore((s) => s.playlists);
  const queueLength = useDownloadsStore((s) => s.queue.length);
  const current = useDownloadsStore((s) => s.current);
  const storage = useDownloadsStore((s) => s.storage);
  const removeTrack = useDownloadsStore((s) => s.removeTrack);

  // Idempotent; the layout's registrar normally beat us to it, but this page
  // may be the first (or only) thing that loads offline.
  useEffect(() => {
    void useDownloadsStore.getState().init();
  }, []);

  if (!ready) return null;

  const pinned = Object.values(tracksById)
    .filter((t) => t.pinned)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const playlists = Object.values(playlistsById).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const currentTrackTitle = current
    ? (tracksById[current.trackId]?.title ?? "track")
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold">Downloads</h1>
        {storage && storage.usage > 0 && (
          <span className="text-xs text-neutral-500">
            {formatBytes(storage.usage)} used
            {storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ""}
          </span>
        )}
      </div>

      {(current || queueLength > 0) && (
        <p className="mb-6 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-300">
          <DownloadIcon size={15} className="animate-pulse text-emerald-400" />
          Downloading {currentTrackTitle}
          {queueLength > 0 ? ` (${queueLength} more queued)` : ""}…
        </p>
      )}

      {playlists.length === 0 && pinned.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-500">
          Nothing downloaded yet. Use the <DownloadIcon size={13} className="inline" />{" "}
          button on songs or the Download button on a playlist — everything here
          stays playable offline.
        </p>
      ) : (
        <>
          {playlists.map((p) => (
            <PlaylistSection key={p.id} playlist={p} />
          ))}
          {pinned.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-1 text-lg font-semibold">Songs</h2>
              <TrackRows
                tracks={pinned}
                onRemove={(t) => void removeTrack(t.id)}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
