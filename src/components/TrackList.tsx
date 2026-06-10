"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "–:––";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function AddToPlaylistMenu({ trackId }: { trackId: string }) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistDTO[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setOpen(!open);
    setMessage(null);
    if (!playlists) {
      try {
        setPlaylists(await api<PlaylistDTO[]>("/playlists"));
      } catch {
        setPlaylists([]);
      }
    }
  };

  const add = async (playlistId: string) => {
    try {
      await api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId }),
      });
      setMessage("Added");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={load}
        aria-label="Add to playlist"
        className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
        title="Add to playlist"
      >
        ＋
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-neutral-700 bg-neutral-800 py-1 text-sm shadow-lg">
          {message && <p className="px-3 py-1 text-emerald-400">{message}</p>}
          {playlists === null && (
            <p className="px-3 py-1 text-neutral-400">Loading…</p>
          )}
          {playlists?.length === 0 && (
            <p className="px-3 py-1 text-neutral-400">No playlists yet</p>
          )}
          {playlists?.map((p) => (
            <button
              key={p.id}
              onClick={() => add(p.id)}
              className="block w-full px-3 py-1 text-left text-neutral-200 hover:bg-neutral-700"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrackList({
  tracks,
  showOwner = false,
  canDelete = false,
  onRemove,
  removeLabel,
  onMove,
}: {
  tracks: TrackDTO[];
  showOwner?: boolean;
  canDelete?: boolean;
  /** Custom remove handler (e.g. remove from playlist instead of deleting). */
  onRemove?: (track: TrackDTO) => Promise<void>;
  removeLabel?: string;
  /** Enables reorder arrows (playlist view). */
  onMove?: (track: TrackDTO, direction: -1 | 1) => Promise<void>;
}) {
  const router = useRouter();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const current = useCurrentTrack();
  const [busyId, setBusyId] = useState<string | null>(null);

  const remove = async (track: TrackDTO) => {
    setBusyId(track.id);
    try {
      if (onRemove) await onRemove(track);
      else await api(`/tracks/${track.id}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (tracks.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-500">No tracks here yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase text-neutral-500">
        <tr className="border-b border-neutral-800">
          <th className="w-10 py-2"></th>
          <th className="py-2">Title</th>
          <th className="py-2">Artist</th>
          <th className="hidden py-2 md:table-cell">Album</th>
          {showOwner && <th className="py-2">Owner</th>}
          <th className="w-14 py-2 text-right">⏱</th>
          <th className="w-20 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((track, i) => {
          const isCurrent = current?.id === track.id;
          return (
            <tr
              key={track.id}
              className={`group border-b border-neutral-800/60 hover:bg-neutral-800/40 ${
                isCurrent ? "text-emerald-400" : "text-neutral-200"
              }`}
            >
              <td className="py-2">
                <button
                  onClick={() => playQueue(tracks, i)}
                  aria-label={`Play ${track.title}`}
                  className="rounded-full p-1 text-neutral-400 hover:text-emerald-400"
                >
                  ▶
                </button>
              </td>
              <td className="max-w-60 truncate py-2 font-medium">{track.title}</td>
              <td className="max-w-40 truncate py-2 text-neutral-400">
                {track.artist ?? "—"}
              </td>
              <td className="hidden max-w-40 truncate py-2 text-neutral-400 md:table-cell">
                {track.album ?? "—"}
              </td>
              {showOwner && (
                <td className="py-2 text-neutral-400">{track.ownerName ?? "You"}</td>
              )}
              <td className="py-2 text-right tabular-nums text-neutral-400">
                {formatDuration(track.durationSec)}
              </td>
              <td className="py-2">
                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                  {onMove && (
                    <>
                      <button
                        onClick={() => onMove(track, -1)}
                        disabled={i === 0}
                        aria-label="Move up"
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => onMove(track, 1)}
                        disabled={i === tracks.length - 1}
                        aria-label="Move down"
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white disabled:opacity-30"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <AddToPlaylistMenu trackId={track.id} />
                  {(canDelete || onRemove) && (
                    <button
                      onClick={() => remove(track)}
                      disabled={busyId === track.id}
                      aria-label={removeLabel ?? "Delete track"}
                      title={removeLabel ?? "Delete track"}
                      className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-red-400 disabled:opacity-50"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
