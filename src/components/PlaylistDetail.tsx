"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { useConfirmStore } from "@/stores/confirm";
import { usePlayerStore } from "@/stores/player";
import AddTracksDialog from "@/components/AddTracksDialog";
import { PlaylistDownloadButton } from "@/components/DownloadButton";
import PlaylistCover from "@/components/PlaylistCover";
import { LockIcon, PencilIcon, PlayIcon, ShuffleIcon, UsersIcon } from "@/components/icons";
import TrackList from "@/components/TrackList";
import { Button } from "@/components/ui/Button";

export default function PlaylistDetail({
  playlist,
  tracks,
  isOwner,
}: {
  playlist: PlaylistDTO;
  tracks: TrackDTO[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [isPrivate, setIsPrivate] = useState(playlist.isPrivate);
  const [coverBusy, setCoverBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Total listen time: sum of known track durations, rounded to minutes,
  // shown as "Xh Ymin" past the hour mark.
  const totalMinutes = Math.round(
    tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0) / 60
  );
  const listenTime =
    totalMinutes >= 60
      ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}min`
      : `${totalMinutes} min`;

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (renameBusy) return;
    setRenameBusy(true);
    try {
      await api(`/playlists/${playlist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setRenaming(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setRenameBusy(false);
    }
  };

  // Optimistic toggle; reverted if the save fails.
  const togglePrivate = async () => {
    const next = !isPrivate;
    setIsPrivate(next);
    try {
      await api(`/playlists/${playlist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPrivate: next }),
      });
    } catch (err) {
      setIsPrivate(!next);
      setError(err instanceof Error ? err.message : "Could not change sharing");
    }
  };

  const uploadCover = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setCoverBusy(true);
    const form = new FormData();
    form.append("file", file);
    try {
      // api() handles the basePath and error extraction; it sets no headers,
      // so the FormData boundary is preserved.
      await api(`/playlists/${playlist.id}/cover`, { method: "POST", body: form });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cover upload failed");
    } finally {
      setCoverBusy(false);
    }
  };

  const deletePlaylist = async () => {
    const ok = await useConfirmStore
      .getState()
      .ask(`Delete playlist “${playlist.name}”?`, { confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await api(`/playlists/${playlist.id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t delete playlist");
      return;
    }
    router.push("/playlists");
    router.refresh();
  };

  const removeTrack = async (track: TrackDTO) => {
    // Failures surface via TrackList's remove/bulkRemove toasts.
    await api(`/playlists/${playlist.id}/tracks/${track.id}`, { method: "DELETE" });
  };

  const reorderTracks = async (trackIds: string[]) => {
    try {
      await api(`/playlists/${playlist.id}/tracks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds }),
      });
    } finally {
      // Resync even on failure so a rejected reorder reverts the optimistic order.
      router.refresh();
    }
  };

  const cover = (
    <PlaylistCover
      playlistId={playlist.id}
      coverS3Key={playlist.coverS3Key}
      artTrackIds={tracks.filter((t) => t.artS3Key).slice(0, 4).map((t) => t.id)}
      iconSize={56}
      className="h-28 w-28 rounded-lg bg-surface-2 sm:h-36 sm:w-36"
    />
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-end gap-5">
        {isOwner ? (
          <>
            <button
              onClick={() => coverInputRef.current?.click()}
              title="Change cover"
              className="group relative shrink-0"
            >
              {cover}
              <span
                className={`absolute inset-0 items-center justify-center rounded-lg bg-black/60 text-sm text-fg ${
                  coverBusy ? "flex" : "hidden group-hover:flex"
                }`}
              >
                {coverBusy ? "Uploading…" : "Change cover"}
              </span>
              {/* Always-visible affordance for touch/mobile, where there's no
                  hover to reveal the overlay above. */}
              <span className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-fg shadow group-hover:hidden">
                <PencilIcon size={14} />
              </span>
            </button>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => uploadCover(e.target.files?.[0])}
            />
          </>
        ) : (
          <div className="shrink-0">{cover}</div>
        )}

        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase text-fg-subtle">Playlist</p>
          {isOwner && renaming ? (
            <form onSubmit={rename} className="flex items-center gap-2">
              {/* Raw input: needs the title's own geometry/size, which would
                  fight the Input primitive's px/py/text utilities. Focus
                  treatment matches Input. */}
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1 text-xl font-bold text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
              />
              <button
                type="submit"
                disabled={renameBusy}
                className="text-sm text-accent-bright hover:text-fg disabled:opacity-50"
              >
                {renameBusy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="text-sm text-fg-muted hover:text-fg"
              >
                Cancel
              </button>
            </form>
          ) : isOwner ? (
            // A real button so renaming is reachable by keyboard, with the
            // pencil making the affordance visible on touch (no hover there).
            <button
              type="button"
              title="Rename"
              onClick={() => setRenaming(true)}
              className="group/name flex min-w-0 max-w-full items-center gap-2 text-left hover:text-accent-bright"
            >
              <h1 className="truncate font-display text-3xl font-bold tracking-tight">
                {playlist.name}
              </h1>
              <PencilIcon
                size={16}
                className="shrink-0 text-fg-subtle group-hover/name:text-accent-bright"
              />
            </button>
          ) : (
            <h1 className="truncate font-display text-3xl font-bold tracking-tight">
              {playlist.name}
            </h1>
          )}
          <p className="mt-1 text-sm text-fg-muted">
            {!isOwner && playlist.ownerName ? `by ${playlist.ownerName} · ` : ""}
            {tracks.length} track{tracks.length === 1 ? "" : "s"}
            {totalMinutes > 0 && ` · ${listenTime}`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              pill
              onClick={() =>
                tracks.length && playQueue(tracks, 0, { collection: true })
              }
              disabled={tracks.length === 0}
            >
              <PlayIcon size={16} />
              Play all
            </Button>
            <Button
              variant="secondary"
              pill
              onClick={() => {
                if (!tracks.length) return;
                usePlayerStore.setState({ shuffled: true });
                playQueue(tracks, Math.floor(Math.random() * tracks.length), {
                  collection: true,
                });
              }}
              disabled={tracks.length === 0}
            >
              <ShuffleIcon size={16} />
              Shuffle all
            </Button>
            {isOwner && (
              <Button variant="outline" pill onClick={() => setAdding(true)}>
                Add songs
              </Button>
            )}
            <PlaylistDownloadButton
              playlistId={playlist.id}
              playlistName={playlist.name}
            />
            {isOwner && (
              <button
                onClick={togglePrivate}
                title={
                  isPrivate
                    ? "Private — only you can see this playlist"
                    : "Shared — friends can see this playlist"
                }
                className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"
              >
                {isPrivate ? <LockIcon size={16} /> : <UsersIcon size={16} />}
                {isPrivate ? "Private" : "Shared"}
              </button>
            )}
            {isOwner && (
              <button
                onClick={deletePlaylist}
                className="text-sm text-fg-muted hover:text-red-400"
              >
                Delete playlist
              </button>
            )}
          </div>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </div>
      </div>

      {isOwner ? (
        <TrackList
          tracks={tracks}
          showOwner
          canEdit
          selectable
          onRemove={removeTrack}
          removeLabel="Remove from playlist"
          onReorder={reorderTracks}
        />
      ) : (
        <TrackList tracks={tracks} showOwner selectable />
      )}

      {isOwner && (
        <AddTracksDialog
          playlistId={playlist.id}
          existingTrackIds={tracks.map((t) => t.id)}
          open={adding}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
