"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import AddTracksDialog from "@/components/AddTracksDialog";
import TrackList from "@/components/TrackList";

export default function PlaylistDetail({
  playlist,
  tracks,
}: {
  playlist: PlaylistDTO;
  tracks: TrackDTO[];
}) {
  const router = useRouter();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(playlist.name);
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

  const moveTrack = async (track: TrackDTO, direction: -1 | 1) => {
    const ids = tracks.map((t) => t.id);
    const from = ids.indexOf(track.id);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await api(`/playlists/${playlist.id}/tracks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: ids }),
    });
    router.refresh();
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-end gap-5">
        <button
          onClick={() => coverInputRef.current?.click()}
          title="Change cover"
          className="group relative shrink-0"
        >
          {playlist.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={playlist.coverUrl}
              alt=""
              className="h-36 w-36 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-36 w-36 items-center justify-center rounded-lg bg-neutral-800 text-5xl">
              🎶
            </div>
          )}
          <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/60 text-sm text-white group-hover:flex">
            Change cover
          </span>
        </button>
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => uploadCover(e.target.files?.[0])}
        />

        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase text-neutral-500">Playlist</p>
          {renaming ? (
            <form onSubmit={rename} className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xl font-bold outline-none focus:border-emerald-500"
              />
              <button type="submit" className="text-sm text-emerald-400 hover:underline">
                Save
              </button>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="text-sm text-neutral-400 hover:text-white"
              >
                Cancel
              </button>
            </form>
          ) : (
            <h1
              className="cursor-pointer truncate text-3xl font-bold hover:underline"
              title="Rename"
              onClick={() => setRenaming(true)}
            >
              {playlist.name}
            </h1>
          )}
          <p className="mt-1 text-sm text-neutral-400">
            {tracks.length} track{tracks.length === 1 ? "" : "s"}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => tracks.length && playQueue(tracks, 0)}
              disabled={tracks.length === 0}
              className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              ▶ Play all
            </button>
            <button
              onClick={() => setAdding(true)}
              className="rounded-full border border-neutral-600 px-5 py-2 text-sm font-semibold text-neutral-200 hover:border-neutral-400"
            >
              Add songs
            </button>
            <button
              onClick={deletePlaylist}
              className="text-sm text-neutral-400 hover:text-red-400"
            >
              Delete playlist
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </div>
      </div>

      <TrackList
        tracks={tracks}
        showOwner
        canEdit
        onRemove={removeTrack}
        removeLabel="Remove from playlist"
        onMove={moveTrack}
      />

      {adding && (
        <AddTracksDialog
          playlistId={playlist.id}
          existingTrackIds={tracks.map((t) => t.id)}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
