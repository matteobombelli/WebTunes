"use client";

import type { TrackDTO } from "@/lib/types";
import { useDownloadsStore, useDownloadStatus } from "@/stores/downloads";
import { DownloadIcon } from "@/components/icons";

// Full-width row style matching the other three-dot menu actions.
const MENU_ROW =
  "flex w-full items-center justify-between gap-3 rounded-md bg-surface-2/40 px-3 py-2.5 text-left hover:bg-surface-3/60";

/** Per-track download toggle for track-list rows. */
export default function DownloadButton({
  track,
  label,
}: {
  track: TrackDTO;
  /** When set, render as a full-width labelled menu row. */
  label?: string;
}) {
  const status = useDownloadStatus(track.id);
  const progress = useDownloadsStore((s) =>
    s.current?.trackId === track.id && s.current.total > 0
      ? Math.floor((s.current.loaded / s.current.total) * 100)
      : null
  );
  const { enqueue, removeTrack } = useDownloadsStore.getState();

  if (status === "queued" || status === "downloading") {
    const title = status === "queued" ? "Waiting to download" : "Downloading";
    const progressText =
      progress !== null ? `${progress}%` : (
        <DownloadIcon size={16} className="animate-pulse" />
      );
    if (label) {
      return (
        <div className={`${MENU_ROW} cursor-default`} title={title}>
          <span>{label}</span>
          <span className="shrink-0 text-xs tabular-nums text-accent-bright">
            {progressText}
          </span>
        </div>
      );
    }
    return (
      <span
        title={title}
        className="flex h-[26px] min-w-[26px] items-center justify-center px-1 text-[10px] tabular-nums text-accent-bright"
      >
        {progressText}
      </span>
    );
  }
  const downloaded = status === "downloaded";
  const onClick = () =>
    downloaded ? removeTrack(track.id) : enqueue([track], { pin: true });
  const ariaLabel = downloaded ? "Remove download" : "Download";
  const title = downloaded ? "Downloaded — click to remove" : "Download";
  if (label) {
    return (
      <button
        onClick={onClick}
        aria-label={ariaLabel}
        title={title}
        className={`${MENU_ROW} ${downloaded ? "text-accent-bright" : ""}`}
      >
        <span>{label}</span>
        <DownloadIcon
          size={16}
          className={`shrink-0 ${downloaded ? "text-accent-bright" : "text-fg-muted"}`}
        />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
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
