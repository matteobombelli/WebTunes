"use client";

import type { TrackDTO } from "@/lib/types";
import { useDownloadsStore, useDownloadStatus } from "@/stores/downloads";
import { DownloadIcon } from "@/components/icons";

/** Per-track download toggle for track-list rows. */
export default function DownloadButton({ track }: { track: TrackDTO }) {
  const status = useDownloadStatus(track.id);
  const progress = useDownloadsStore((s) =>
    s.current?.trackId === track.id && s.current.total > 0
      ? Math.floor((s.current.loaded / s.current.total) * 100)
      : null
  );
  const { enqueue, removeTrack } = useDownloadsStore.getState();

  if (status === "queued" || status === "downloading") {
    return (
      <span
        title={status === "queued" ? "Waiting to download" : "Downloading"}
        className="flex h-[26px] min-w-[26px] items-center justify-center px-1 text-[10px] tabular-nums text-accent-bright"
      >
        {progress !== null ? `${progress}%` : (
          <DownloadIcon size={16} className="animate-pulse" />
        )}
      </span>
    );
  }
  const downloaded = status === "downloaded";
  return (
    <button
      onClick={() =>
        downloaded ? removeTrack(track.id) : enqueue([track], { pin: true })
      }
      aria-label={downloaded ? "Remove download" : "Download"}
      title={downloaded ? "Downloaded — click to remove" : "Download"}
      className={`rounded p-1 hover:bg-surface-3 ${
        downloaded
          ? "text-accent-bright hover:text-red-400"
          : "text-fg-muted hover:text-white"
      }`}
    >
      <DownloadIcon size={16} />
    </button>
  );
}

/** Whole-playlist download toggle for the playlist header. */
export function PlaylistDownloadButton({
  playlistId,
  playlistName,
}: {
  playlistId: string;
  playlistName: string;
}) {
  const record = useDownloadsStore((s) => s.playlists[playlistId]);
  const downloadedCount = useDownloadsStore((s) =>
    record ? record.trackIds.filter((id) => s.tracks[id]).length : 0
  );
  const active = useDownloadsStore((s) =>
    record
      ? record.trackIds.some(
          (id) =>
            s.current?.trackId === id || s.queue.some((q) => q.track.id === id)
        )
      : false
  );
  const { downloadPlaylist, removePlaylist } = useDownloadsStore.getState();

  const total = record?.trackIds.length ?? 0;
  const complete = record && downloadedCount === total;

  if (record && active) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border px-5 py-2 text-sm font-semibold text-fg-muted">
        <DownloadIcon size={15} className="animate-pulse" />
        {downloadedCount}/{total}
      </span>
    );
  }
  if (complete) {
    return (
      <button
        onClick={() => {
          if (confirm(`Remove "${playlistName}" from downloads?`)) {
            removePlaylist(playlistId);
          }
        }}
        title="Downloaded — click to remove"
        className="flex items-center gap-1.5 rounded-full border border-accent px-5 py-2 text-sm font-semibold text-accent-bright hover:border-red-500 hover:text-red-400"
      >
        <DownloadIcon size={15} />
        Downloaded
      </button>
    );
  }
  return (
    <button
      onClick={() => downloadPlaylist(playlistId)}
      className="flex items-center gap-1.5 rounded-full border border-border px-5 py-2 text-sm font-semibold text-fg hover:border-fg-muted"
    >
      <DownloadIcon size={15} />
      {record ? "Resume download" : "Download"}
    </button>
  );
}
