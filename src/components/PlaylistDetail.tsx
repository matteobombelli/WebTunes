"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { FriendDTO, PlaylistDTO, TrackDTO } from "@/lib/types";
import { useConfirmStore } from "@/stores/confirm";
import { usePlayerStore } from "@/stores/player";
import { useToastStore } from "@/stores/toast";
import AddTracksDialog from "@/components/AddTracksDialog";
import CollaboratorsDialog from "@/components/CollaboratorsDialog";
import { PlaylistDownloadButton } from "@/components/DownloadButton";
import PlaylistCover from "@/components/PlaylistCover";
import PlaylistRecommendations from "@/components/PlaylistRecommendations";
import {
  CheckIcon,
  CopyIcon,
  LockIcon,
  LoaderIcon,
  LogoutIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ShuffleIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from "@/components/icons";
import TrackList from "@/components/TrackList";
import { Button } from "@/components/ui/Button";

const actionIconClass = "h-6 w-6 sm:h-4 sm:w-4";
const quietMobileActionClass =
  "flex h-10 w-10 items-center justify-center gap-1.5 rounded-full text-sm sm:h-auto sm:w-auto sm:rounded-none";

export default function PlaylistDetail({
  playlist,
  tracks,
  viewerId,
  isOwner,
  canEdit,
  collaborators,
}: {
  playlist: PlaylistDTO;
  tracks: TrackDTO[];
  viewerId: string;
  isOwner: boolean;
  /** Owner OR collaborator: may add/remove/reorder tracks, rename, set cover. */
  canEdit: boolean;
  collaborators: FriendDTO[];
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
  const [managingCollab, setManagingCollab] = useState(false);
  const [copying, setCopying] = useState(false);

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

  const leavePlaylist = async () => {
    const ok = await useConfirmStore
      .getState()
      .ask(`Stop collaborating on “${playlist.name}”?`, { confirmLabel: "Leave" });
    if (!ok) return;
    try {
      await api(`/playlists/${playlist.id}/collaborators?userId=${viewerId}`, {
        method: "DELETE",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t leave playlist");
      return;
    }
    router.push("/playlists");
    router.refresh();
  };

  const removeTrack = async (track: TrackDTO) => {
    // Failures surface via TrackList's remove/bulkRemove toasts.
    await api(`/playlists/${playlist.id}/tracks/${track.id}`, { method: "DELETE" });
  };

  const duplicate = async () => {
    if (copying) return;
    setCopying(true);
    setError(null);
    try {
      const copy = await api<PlaylistDTO>(
        `/playlists/${playlist.id}/duplicate`,
        { method: "POST" }
      );
      useToastStore
        .getState()
        .show(isOwner ? "Playlist duplicated" : "Playlist saved to your library");
      router.push(`/playlists/${copy.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t copy playlist");
      setCopying(false);
    }
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
        {canEdit ? (
          <>
            <button
              onClick={() => coverInputRef.current?.click()}
              title="Change cover"
              className="group relative shrink-0"
            >
              {cover}
              <span
                className={`absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-sm text-fg transition-opacity ${
                  coverBusy ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                {coverBusy ? "Uploading…" : "Change cover"}
              </span>
              {/* Always-visible affordance for touch/mobile, where there's no
                  hover to reveal the overlay above. */}
              <span className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-fg shadow transition-opacity group-hover:opacity-0">
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
          {canEdit && renaming ? (
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
                aria-label={renameBusy ? "Saving" : "Save playlist name"}
                title={renameBusy ? "Saving" : "Save"}
                className="flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-sm text-accent-bright hover:bg-surface-2 hover:text-fg disabled:opacity-50 sm:h-auto sm:w-auto sm:rounded-none sm:hover:bg-transparent"
              >
                {renameBusy ? (
                  <LoaderIcon size={18} className="animate-spin" />
                ) : (
                  <CheckIcon size={18} />
                )}
                <span className="hidden sm:inline">
                  {renameBusy ? "Saving…" : "Save"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                aria-label="Cancel renaming"
                title="Cancel"
                className="flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-sm text-fg-muted hover:bg-surface-2 hover:text-fg sm:h-auto sm:w-auto sm:rounded-none sm:hover:bg-transparent"
              >
                <XIcon size={18} />
                <span className="hidden sm:inline">Cancel</span>
              </button>
            </form>
          ) : canEdit ? (
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
            {canEdit && (
              <Button
                variant="outline"
                pill
                iconOnlyOnMobile
                aria-label="Add songs"
                title="Add songs"
                onClick={() => setAdding(true)}
              >
                <PlusIcon className={actionIconClass} />
                <span className="hidden sm:inline">Add songs</span>
              </Button>
            )}
            <PlaylistDownloadButton
              playlistId={playlist.id}
              playlistName={playlist.name}
            />
            <Button
              variant="outline"
              pill
              iconOnlyOnMobile
              onClick={duplicate}
              disabled={copying}
              aria-label={
                copying
                  ? "Copying playlist"
                  : isOwner
                    ? "Duplicate playlist"
                    : "Save a copy"
              }
              title={isOwner ? "Duplicate playlist" : "Save a copy"}
            >
              {copying ? (
                <LoaderIcon className={`${actionIconClass} animate-spin`} />
              ) : (
                <CopyIcon className={actionIconClass} />
              )}
              <span className="hidden sm:inline">
                {copying ? "Copying…" : isOwner ? "Duplicate" : "Save a copy"}
              </span>
            </Button>
          </div>
          {/* Ownership/collaboration controls live on their own quieter row so
              the primary playback/content actions above stay scannable. Keep
              destructive actions last, with sharing controls to their left. */}
          {(isOwner || canEdit) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {isOwner && (
                <button
                  onClick={togglePrivate}
                  title={
                    isPrivate
                      ? "Private - only you can see this playlist"
                      : "Shared - friends can see this playlist"
                  }
                  aria-label={
                    isPrivate ? "Private playlist" : "Shared playlist"
                  }
                  className={`${quietMobileActionClass} text-fg-muted hover:bg-surface-2 hover:text-fg sm:hover:bg-transparent`}
                >
                  {isPrivate ? (
                    <LockIcon className={actionIconClass} />
                  ) : (
                    <UsersIcon className={actionIconClass} />
                  )}
                  <span className="hidden sm:inline">
                    {isPrivate ? "Private" : "Shared"}
                  </span>
                </button>
              )}
              {isOwner && (
                <button
                  onClick={() => setManagingCollab(true)}
                  aria-label="Manage collaborators"
                  className={`${quietMobileActionClass} text-fg-muted hover:bg-surface-2 hover:text-fg sm:hover:bg-transparent`}
                  title="Manage collaborators"
                >
                  <UsersIcon className={actionIconClass} />
                  <span className="hidden sm:inline">
                    {collaborators.length
                      ? `Collaborators · ${collaborators.length}`
                      : "Add collaborators"}
                  </span>
                </button>
              )}
              {isOwner && (
                <button
                  onClick={deletePlaylist}
                  aria-label="Delete playlist"
                  title="Delete playlist"
                  className={`${quietMobileActionClass} text-fg-muted hover:bg-red-500/10 hover:text-red-400 sm:hover:bg-transparent`}
                >
                  <TrashIcon className={actionIconClass} />
                  <span className="hidden sm:inline">Delete playlist</span>
                </button>
              )}
              {!isOwner && canEdit && (
                <button
                  onClick={leavePlaylist}
                  aria-label="Leave playlist"
                  title="Leave playlist"
                  className={`${quietMobileActionClass} text-fg-muted hover:bg-red-500/10 hover:text-red-400 sm:hover:bg-transparent`}
                >
                  <LogoutIcon className={actionIconClass} />
                  <span className="hidden sm:inline">Leave playlist</span>
                </button>
              )}
            </div>
          )}
          {/* Collaborator avatars - shown to anyone viewing so it's clear the
              playlist is shared. */}
          {collaborators.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase text-fg-subtle">
                Collaborators
              </span>
              {collaborators.map((c) => (
                <span
                  key={c.id}
                  title={c.name}
                  className="flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-1 pr-2.5 text-sm"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent-bright">
                    {c.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="max-w-32 truncate">{c.name}</span>
                </span>
              ))}
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </div>
      </div>

      {canEdit ? (
        <TrackList
          tracks={tracks}
          showOwner
          canEdit
          selectable
          sortable
          onRemove={removeTrack}
          removeLabel="Remove from playlist"
          onReorder={reorderTracks}
        />
      ) : (
        <TrackList tracks={tracks} showOwner selectable sortable />
      )}

      <PlaylistRecommendations playlistId={playlist.id} canEdit={canEdit} />

      {canEdit && (
        <AddTracksDialog
          playlistId={playlist.id}
          existingTrackIds={tracks.map((t) => t.id)}
          open={adding}
          onClose={() => setAdding(false)}
        />
      )}

      {isOwner && (
        <CollaboratorsDialog
          playlistId={playlist.id}
          collaborators={collaborators}
          open={managingCollab}
          onClose={() => setManagingCollab(false)}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}
