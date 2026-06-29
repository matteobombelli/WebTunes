"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
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
  const [name, setName] = useState(playlist.name);
  const [isPrivate, setIsPrivate] = useState(playlist.isPrivate);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
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
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE_PATH}/api/playlists/${playlist.id}/cover`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Cover upload failed");
      return;
    }
    router.refresh();
  };

  const deletePlaylist = async () => {
    if (!confirm(`Delete playlist "${playlist.name}"?`)) return;
    await api(`/playlists/${playlist.id}`, { method: "DELETE" });
    router.push("/playlists");
    router.refresh();
  };

  const removeTrack = async (track: TrackDTO) => {
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
              <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/60 text-sm text-white group-hover:flex">
                Change cover
              </span>
              {/* Always-visible affordance for touch/mobile, where there's no
                  hover to reveal the overlay above. */}
              <span className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white shadow group-hover:hidden">
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
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xl font-bold outline-none focus:border-accent"
              />
              <button type="submit" className="text-sm text-accent-bright hover:text-white">
                Save
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="text-sm text-fg-muted hover:text-white"
              >
                Cancel
              </button>
            </form>
          ) : isOwner ? (
            <h1
              className="cursor-pointer truncate font-display text-3xl font-bold tracking-tight hover:text-accent-bright"
              title="Rename"
              onClick={() => setRenaming(true)}
            >
              {playlist.name}
            </h1>
          ) : (
            <h1 className="truncate font-display text-3xl font-bold tracking-tight">
              {playlist.name}
            </h1>
          )}
          <p className="mt-1 text-sm text-fg-muted">
            {!isOwner && playlist.ownerName ? `by ${playlist.ownerName} · ` : ""}
            {tracks.length} track{tracks.length === 1 ? "" : "s"}
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
                className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-white"
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
