"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DownloadedPlaylist, DownloadedTrack } from "@/lib/offline/db";
import { useConfirmStore } from "@/stores/confirm";
import { useDownloadsStore } from "@/stores/downloads";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import {
  ChevronLeftIcon,
  DownloadIcon,
  LockIcon,
  MusicIcon,
  XIcon,
} from "@/components/icons";
import PlaylistCover from "@/components/PlaylistCover";
import TrackArt from "@/components/TrackArt";
import { TrackRowsSkeleton } from "@/components/ui/Skeleton";

// The offline workhorse: everything rendered here comes from the downloads
// store (IndexedDB) — no server data, no API-dependent actions. TrackList is
// deliberately not reused; its row actions (edit, add-to-playlist,
// router.refresh) all assume a network. Card → track-list navigation is
// client state, not a sub-route: the SW's offline fallback only covers
// /downloads itself.

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const TrackRows = memo(function TrackRows({
  tracks,
  onRemove,
}: {
  tracks: DownloadedTrack[];
  onRemove?: (track: DownloadedTrack) => void;
}) {
  const playQueue = usePlayerStore((s) => s.playQueue);
  const current = useCurrentTrack();
  return (
    <ul className="divide-y divide-border-subtle/60">
      {tracks.map((track, i) => (
        <li
          key={track.id}
          className={`group flex items-center gap-3 py-2 ${
            current?.id === track.id ? "text-accent-bright" : "text-fg"
          }`}
        >
          <button
            onClick={() => playQueue(tracks, i)}
            title={`Play ${track.title}`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-accent-bright"
          >
            <TrackArt track={track} size="h-11 w-11 sm:h-9 sm:w-9" iconSize={18} thumb />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{track.title}</span>
              <span className="block truncate text-xs text-fg-muted">
                {track.artist ?? "Unknown artist"}
                {track.ownerName ? ` · from ${track.ownerName}` : ""}
              </span>
            </span>
          </button>
          {track.fileSize !== null && (
            <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
              {formatBytes(track.fileSize)}
            </span>
          )}
          {onRemove && (
            <button
              onClick={() => onRemove(track)}
              aria-label="Remove download"
              title="Remove download"
              className="shrink-0 rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-red-400"
            >
              <XIcon size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
});

/** A grid tile styled like PlaylistCard, but a button (no route to link to). */
function DownloadCard({
  cover,
  title,
  subtitle,
  locked = false,
  onOpen,
}: {
  cover: React.ReactNode;
  title: string;
  subtitle: string;
  locked?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="group relative block w-full text-left transition duration-200 ease-out hover:z-10 hover:scale-105"
    >
      <div className="overflow-hidden rounded-md">{cover}</div>
      <p className="mt-2 flex items-center gap-1 truncate font-medium text-fg">
        {locked && <LockIcon size={13} className="shrink-0 text-fg-subtle" />}
        <span className="truncate">{title}</span>
      </p>
      <p className="truncate text-xs text-fg-subtle">{subtitle}</p>
    </button>
  );
}

const PlaylistDetail = memo(function PlaylistDetail({
  playlist,
  onBack,
}: {
  playlist: DownloadedPlaylist;
  onBack: () => void;
}) {
  const tracksById = useDownloadsStore((s) => s.tracks);
  const removePlaylist = useDownloadsStore((s) => s.removePlaylist);
  // Only members whose audio is on the device; the rest are still queued or
  // failed and will arrive on a later online sync.
  const tracks = playlist.trackIds
    .map((id) => tracksById[id])
    .filter((t): t is DownloadedTrack => t !== undefined);
  return (
    <section>
      <div className="mb-1 flex items-center gap-3">
        <h2 className="truncate font-display text-lg font-semibold">{playlist.name}</h2>
        <span className="text-xs text-fg-subtle">
          {tracks.length}/{playlist.trackIds.length} downloaded
        </span>
        <button
          onClick={async () => {
            const ok = await useConfirmStore
              .getState()
              .ask(`Remove “${playlist.name}” from downloads?`, {
                confirmLabel: "Remove",
              });
            if (ok) {
              void removePlaylist(playlist.id);
              onBack();
            }
          }}
          className="ml-auto shrink-0 text-xs text-fg-muted hover:text-red-400"
        >
          Remove
        </button>
      </div>
      <TrackRows tracks={tracks} />
    </section>
  );
});

// Sentinel id for the directly-downloaded songs card ("library"); playlist
// cards use their uuid, so no collision is possible.
const LIBRARY = "library";

export default function DownloadsBrowser() {
  const ready = useDownloadsStore((s) => s.ready);
  const tracksById = useDownloadsStore((s) => s.tracks);
  const playlistsById = useDownloadsStore((s) => s.playlists);
  const queueLength = useDownloadsStore((s) => s.queue.length);
  const current = useDownloadsStore((s) => s.current);
  const storage = useDownloadsStore((s) => s.storage);
  const removeTrack = useDownloadsStore((s) => s.removeTrack);
  const removeAll = useDownloadsStore((s) => s.removeAll);
  // Which card is open: null = card grid, LIBRARY, or a playlist id.
  const [open, setOpen] = useState<string | null>(null);

  // Idempotent; the layout's registrar normally beat us to it, but this page
  // may be the first (or only) thing that loads offline.
  useEffect(() => {
    void useDownloadsStore.getState().init();
  }, []);

  // Stable derived lists + remove handler so the memoized sections don't
  // re-render on every download-progress tick (only on actual data changes).
  const pinned = useMemo(
    () =>
      Object.values(tracksById)
        .filter((t) => t.pinned)
        .sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
        ),
    [tracksById]
  );
  const playlists = useMemo(
    () =>
      Object.values(playlistsById).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      ),
    [playlistsById]
  );
  const onRemovePinned = useCallback(
    (t: DownloadedTrack) => void removeTrack(t.id),
    [removeTrack]
  );
  const onBack = useCallback(() => setOpen(null), []);

  // Page-shell skeleton while IndexedDB hydrates — usually one frame, but this
  // page is the landing surface on the slow-connection fallback path.
  if (!ready)
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-6 font-display text-4xl font-bold tracking-tight">
          Downloads
        </h1>
        <TrackRowsSkeleton />
      </div>
    );

  const currentTrackTitle = current
    ? (tracksById[current.trackId]?.title ?? "track")
    : null;

  // Derived, not synced: a playlist removed elsewhere simply falls back to
  // the grid on the next render.
  const openPlaylist =
    open && open !== LIBRARY ? playlistsById[open] : undefined;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="font-display text-4xl font-bold tracking-tight">Downloads</h1>
        {storage && storage.usage > 0 && (
          <span className="text-xs text-fg-subtle">
            {formatBytes(storage.usage)} used
            {storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ""}
          </span>
        )}
        {(playlists.length > 0 || pinned.length > 0) && (
          <button
            onClick={async () => {
              const ok = await useConfirmStore
                .getState()
                .ask("Remove all downloads?", { confirmLabel: "Remove all" });
              if (ok) void removeAll();
            }}
            className="ml-auto shrink-0 text-xs text-fg-muted hover:text-red-400"
          >
            Remove all
          </button>
        )}
      </div>

      {(current || queueLength > 0) && (
        <p className="mb-6 flex items-center gap-2 rounded-md border border-border-subtle bg-surface-1 px-4 py-2 text-sm text-fg-muted">
          <DownloadIcon size={15} className="animate-pulse text-accent-bright" />
          Downloading {currentTrackTitle}
          {queueLength > 0 ? ` (${queueLength} more queued)` : ""}…
        </p>
      )}

      {open === LIBRARY || openPlaylist ? (
        <>
          <button
            onClick={onBack}
            className="mb-3 flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
          >
            <ChevronLeftIcon size={14} />
            Back
          </button>
          {openPlaylist ? (
            <PlaylistDetail playlist={openPlaylist} onBack={onBack} />
          ) : (
            <section>
              <div className="mb-1 flex items-center gap-3">
                <h2 className="font-display text-lg font-semibold">Library</h2>
                <span className="text-xs text-fg-subtle">
                  {pinned.length} song{pinned.length === 1 ? "" : "s"}
                </span>
              </div>
              {pinned.length === 0 ? (
                <p className="py-8 text-center text-sm text-fg-muted">
                  No downloaded songs.
                </p>
              ) : (
                <TrackRows tracks={pinned} onRemove={onRemovePinned} />
              )}
            </section>
          )}
        </>
      ) : playlists.length === 0 && pinned.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">
          Nothing downloaded yet. Use the <DownloadIcon size={13} className="inline" />{" "}
          button on songs or the Download button on a playlist — everything here
          stays playable offline.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div className="animate-fade-in-up">
            <DownloadCard
              cover={
                <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
                  <MusicIcon size={48} />
                </div>
              }
              title="Library"
              subtitle={`${pinned.length} song${pinned.length === 1 ? "" : "s"}`}
              onOpen={() => setOpen(LIBRARY)}
            />
          </div>
          {playlists.map((p, i) => {
            const downloaded = p.trackIds.filter((id) => tracksById[id]);
            // Mosaic from downloaded art-bearing members: their art is what
            // the download manager put in wt-art, so covers render offline
            // (an uploaded playlist cover would not — it is never cached).
            const artIds = downloaded
              .filter((id) => tracksById[id].artS3Key)
              .slice(0, 4);
            return (
              <div
                key={p.id}
                className="animate-fade-in-up"
                style={{ animationDelay: `${Math.min(i + 1, 8) * 0.03}s` }}
              >
                <DownloadCard
                  cover={
                    <PlaylistCover
                      playlistId={p.id}
                      coverS3Key={null}
                      artTrackIds={artIds}
                      iconSize={48}
                      className="aspect-square w-full bg-surface-2"
                    />
                  }
                  title={p.name}
                  subtitle={`${p.ownerName ? `${p.ownerName} · ` : ""}${downloaded.length}/${p.trackIds.length} downloaded`}
                  locked={!p.ownerName && p.isPrivate}
                  onOpen={() => setOpen(p.id)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
