"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DownloadedTrack } from "@/lib/offline/db";
import { useConfirmStore } from "@/stores/confirm";
import { useDownloadsStore } from "@/stores/downloads";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import {
  ChevronLeftIcon,
  DownloadIcon,
  LockIcon,
  MusicIcon,
  PlayIcon,
  SearchIcon,
  ShuffleIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons";
import PlaylistCover from "@/components/PlaylistCover";
import MobileSwipeTrack from "@/components/MobileSwipeAction";
import TrackArt from "@/components/TrackArt";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TrackRowsSkeleton } from "@/components/ui/Skeleton";

// The offline workhorse: everything rendered here comes from the downloads
// store (IndexedDB) - no server data, no API-dependent actions. TrackList is
// deliberately not reused; its row actions (edit, add-to-playlist,
// router.refresh) all assume a network. Card → track-list navigation is
// client state, not a sub-route: the SW's offline fallback only covers
// /downloads itself.

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Same formats as TrackList / PlaylistDetail, so an opened card reads like a
// playlist page.
function formatDuration(seconds: number | null): string {
  if (!seconds) return "–:––";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatListenTime(tracks: DownloadedTrack[]): string | null {
  const totalMinutes = Math.round(
    tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0) / 60
  );
  if (totalMinutes <= 0) return null;
  return totalMinutes >= 60
    ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}min`
    : `${totalMinutes} min`;
}

function matchesQuery(track: DownloadedTrack, query: string): boolean {
  return [track.title, track.artist, track.album].some((field) =>
    field?.toLocaleLowerCase().includes(query)
  );
}

const TrackRows = memo(function TrackRows({
  tracks,
  onRemove,
}: {
  tracks: DownloadedTrack[];
  onRemove?: (track: DownloadedTrack) => void;
}) {
  const playQueue = usePlayerStore((s) => s.playQueue);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const current = useCurrentTrack();
  return (
    <ul className="border-t border-border-subtle/60">
      {tracks.map((track, i) => (
        <MobileSwipeTrack
          key={track.id}
          as="li"
          track={track}
          contentClassName={`group flex items-center gap-3 border-b border-border-subtle/60 py-2.5 transition-colors hover:bg-surface-2/40 sm:py-2 ${
            current?.id === track.id ? "text-accent-bright" : "text-fg"
          }`}
        >
          <button
            onClick={() => playQueue(tracks, i)}
            title={`Play ${track.title}`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-accent-bright"
          >
            <span className="relative shrink-0">
              <TrackArt track={track} size="h-11 w-11 sm:h-9 sm:w-9" iconSize={18} thumb />
              {current?.id === track.id && (
                <span className="absolute inset-0 flex items-center justify-center rounded bg-black/45 text-accent-bright">
                  <NowPlayingBars playing={isPlaying} />
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-medium sm:text-sm">
                {track.title}
              </span>
              <span className="block truncate text-xs text-fg-muted">
                {track.artist ?? "Unknown artist"}
                {track.ownerName ? ` · from ${track.ownerName}` : ""}
              </span>
            </span>
          </button>
          {track.fileSize !== null && (
            <span className="hidden shrink-0 text-xs tabular-nums text-fg-subtle sm:inline">
              {formatBytes(track.fileSize)}
            </span>
          )}
          <span className="w-12 shrink-0 text-center text-sm tabular-nums text-fg-muted">
            {formatDuration(track.durationSec)}
          </span>
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
        </MobileSwipeTrack>
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

const actionIconClass = "h-6 w-6 sm:h-4 sm:w-4";

/** An opened card, laid out like the playlist page (PlaylistDetail.tsx). */
function CollectionDetail({
  cover,
  label,
  title,
  meta,
  tracks,
  controls,
  onRemove,
  children,
}: {
  cover: React.ReactNode;
  label: string;
  title: string;
  meta: string;
  /** The visible (sorted/filtered) tracks Play all / Shuffle all start. */
  tracks: DownloadedTrack[];
  controls?: React.ReactNode;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  const playQueue = usePlayerStore((s) => s.playQueue);
  return (
    <section>
      <div className="mb-6 flex flex-wrap items-end gap-5">
        <div className="shrink-0">{cover}</div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase text-fg-subtle">{label}</p>
          <h2 className="truncate font-display text-3xl font-bold tracking-tight">
            {title}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">{meta}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              pill
              iconOnlyOnMobile
              aria-label="Play all"
              title="Play all"
              onClick={() =>
                tracks.length && playQueue(tracks, 0, { collection: true })
              }
              disabled={tracks.length === 0}
            >
              <PlayIcon className={actionIconClass} />
              <span className="hidden sm:inline">Play all</span>
            </Button>
            <Button
              variant="secondary"
              pill
              iconOnlyOnMobile
              aria-label="Shuffle all"
              title="Shuffle all"
              onClick={() => {
                if (!tracks.length) return;
                usePlayerStore.setState({ shuffled: true });
                playQueue(tracks, Math.floor(Math.random() * tracks.length), {
                  collection: true,
                });
              }}
              disabled={tracks.length === 0}
            >
              <ShuffleIcon className={actionIconClass} />
              <span className="hidden sm:inline">Shuffle all</span>
            </Button>
            {onRemove && (
              <button
                onClick={onRemove}
                aria-label="Remove download"
                title="Remove download"
                className="flex h-10 w-10 items-center justify-center gap-1.5 rounded-full text-sm text-fg-muted hover:bg-red-500/10 hover:text-red-400 sm:h-auto sm:w-auto sm:rounded-none sm:hover:bg-transparent"
              >
                <TrashIcon className={actionIconClass} />
                <span className="hidden sm:inline">Remove download</span>
              </button>
            )}
            {controls && <div className="ml-auto">{controls}</div>}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

// Sentinel id for the directly-downloaded songs card ("library"); playlist
// cards use their uuid, so no collision is possible.
const LIBRARY = "library";

// Client-side orderings for the downloaded-songs list.
const LIBRARY_SORTS = [
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "size", label: "Size" },
] as const;
type LibrarySortKey = (typeof LIBRARY_SORTS)[number]["value"];

export default function DownloadsBrowser() {
  const ready = useDownloadsStore((s) => s.ready);
  const tracksById = useDownloadsStore((s) => s.tracks);
  const playlistsById = useDownloadsStore((s) => s.playlists);
  const queueLength = useDownloadsStore((s) => s.queue.length);
  const current = useDownloadsStore((s) => s.current);
  const storage = useDownloadsStore((s) => s.storage);
  const removeTrack = useDownloadsStore((s) => s.removeTrack);
  const removePlaylist = useDownloadsStore((s) => s.removePlaylist);
  const removeAll = useDownloadsStore((s) => s.removeAll);
  // Which card is open: null = card grid, LIBRARY, or a playlist id.
  const [open, setOpen] = useState<string | null>(null);
  const [librarySort, setLibrarySort] = useState<LibrarySortKey>("title");
  const [q, setQ] = useState("");
  const query = q.trim().toLocaleLowerCase();

  // Idempotent; the layout's registrar normally beat us to it, but this page
  // may be the first (or only) thing that loads offline.
  useEffect(() => {
    void useDownloadsStore.getState().init();
  }, []);

  // Stable derived lists + remove handler so the memoized sections don't
  // re-render on every download-progress tick (only on actual data changes).
  const pinned = useMemo(() => {
    const list = Object.values(tracksById).filter((t) => t.pinned);
    if (librarySort === "size") {
      list.sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0));
    } else {
      // "￿" sentinel sorts tracks with no artist last, like TrackList.
      const text = (t: DownloadedTrack) =>
        librarySort === "artist" ? (t.artist ?? "￿") : t.title;
      list.sort((a, b) =>
        text(a).localeCompare(text(b), undefined, { sensitivity: "base" })
      );
    }
    return list;
  }, [tracksById, librarySort]);
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
  // Search is per view, so moving between the grid and a card starts clean.
  const openCard = useCallback((id: string | null) => {
    setOpen(id);
    setQ("");
  }, []);
  const onBack = useCallback(() => openCard(null), [openCard]);

  // Derived, not synced: a playlist removed elsewhere simply falls back to
  // the grid on the next render.
  const openPlaylist =
    open && open !== LIBRARY ? playlistsById[open] : undefined;
  // Only members whose audio is on the device; the rest are still queued or
  // failed and will arrive on a later online sync.
  const openPlaylistTracks = useMemo(
    () =>
      openPlaylist
        ? openPlaylist.trackIds
            .map((id) => tracksById[id])
            .filter((t): t is DownloadedTrack => t !== undefined)
        : [],
    [openPlaylist, tracksById]
  );
  const visiblePlaylistTracks = useMemo(
    () =>
      query
        ? openPlaylistTracks.filter((t) => matchesQuery(t, query))
        : openPlaylistTracks,
    [openPlaylistTracks, query]
  );
  const visiblePinned = useMemo(
    () => (query ? pinned.filter((t) => matchesQuery(t, query)) : pinned),
    [pinned, query]
  );
  // Grid-level search spans every downloaded song, pinned or playlist-only.
  const songResults = useMemo(
    () =>
      query && open === null
        ? Object.values(tracksById)
            .filter((t) => matchesQuery(t, query))
            .sort((a, b) =>
              a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
            )
        : [],
    [tracksById, query, open]
  );
  const visiblePlaylists = useMemo(
    () =>
      query
        ? playlists.filter((p) => p.name.toLocaleLowerCase().includes(query))
        : playlists,
    [playlists, query]
  );

  // Page-shell skeleton while IndexedDB hydrates - usually one frame, but this
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

  const coverClass = "h-28 w-28 rounded-lg bg-surface-2 sm:h-36 sm:w-36";
  const noMatches = (
    <p className="py-8 text-center text-sm text-fg-muted">No matching songs.</p>
  );

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

      {(playlists.length > 0 || pinned.length > 0) && (
        <div className="relative mb-6">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              open === null
                ? "Search downloads…"
                : "Search title, artist, or album…"
            }
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
            <CollectionDetail
              cover={
                <PlaylistCover
                  playlistId={openPlaylist.id}
                  coverS3Key={null}
                  artTrackIds={openPlaylistTracks
                    .filter((t) => t.artS3Key)
                    .slice(0, 4)
                    .map((t) => t.id)}
                  iconSize={56}
                  className={coverClass}
                />
              }
              label="Playlist"
              title={openPlaylist.name}
              meta={[
                openPlaylist.ownerName ? `by ${openPlaylist.ownerName}` : null,
                `${openPlaylistTracks.length}/${openPlaylist.trackIds.length} downloaded`,
                formatListenTime(openPlaylistTracks),
              ]
                .filter(Boolean)
                .join(" · ")}
              tracks={visiblePlaylistTracks}
              onRemove={async () => {
                const ok = await useConfirmStore
                  .getState()
                  .ask(`Remove “${openPlaylist.name}” from downloads?`, {
                    confirmLabel: "Remove",
                  });
                if (ok) {
                  void removePlaylist(openPlaylist.id);
                  onBack();
                }
              }}
            >
              {visiblePlaylistTracks.length === 0 && query ? (
                noMatches
              ) : (
                <TrackRows tracks={visiblePlaylistTracks} />
              )}
            </CollectionDetail>
          ) : (
            <CollectionDetail
              cover={
                <div
                  className={`flex items-center justify-center text-fg-subtle ${coverClass}`}
                >
                  <MusicIcon size={56} />
                </div>
              }
              label="Downloads"
              title="Library"
              meta={[
                `${pinned.length} song${pinned.length === 1 ? "" : "s"}`,
                formatListenTime(pinned),
              ]
                .filter(Boolean)
                .join(" · ")}
              tracks={visiblePinned}
              controls={
                pinned.length > 1 && (
                  <SegmentedControl
                    options={LIBRARY_SORTS}
                    value={librarySort}
                    onChange={setLibrarySort}
                  />
                )
              }
            >
              {pinned.length === 0 ? (
                <p className="py-8 text-center text-sm text-fg-muted">
                  No downloaded songs.
                </p>
              ) : visiblePinned.length === 0 ? (
                noMatches
              ) : (
                <TrackRows tracks={visiblePinned} onRemove={onRemovePinned} />
              )}
            </CollectionDetail>
          )}
        </>
      ) : playlists.length === 0 && pinned.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">
          Nothing downloaded yet. Use the <DownloadIcon size={13} className="inline" />{" "}
          button on songs or the Download button on a playlist - everything here
          stays playable offline.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {!query && (
              <div className="animate-fade-in-up">
                <DownloadCard
                  cover={
                    <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
                      <MusicIcon size={48} />
                    </div>
                  }
                  title="Library"
                  subtitle={`${pinned.length} song${pinned.length === 1 ? "" : "s"}`}
                  onOpen={() => openCard(LIBRARY)}
                />
              </div>
            )}
            {visiblePlaylists.map((p, i) => {
              const downloaded = p.trackIds.filter((id) => tracksById[id]);
              // Mosaic from downloaded art-bearing members: their art is what
              // the download manager put in wt-art, so covers render offline
              // (an uploaded playlist cover would not - it is never cached).
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
                    onOpen={() => openCard(p.id)}
                  />
                </div>
              );
            })}
          </div>
          {query &&
            (songResults.length > 0 ? (
              <div className={visiblePlaylists.length > 0 ? "mt-6" : ""}>
                <TrackRows tracks={songResults} />
              </div>
            ) : (
              visiblePlaylists.length === 0 && noMatches
            ))}
        </>
      )}
    </div>
  );
}
