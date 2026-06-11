"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";

export default function EditTrackDialog({
  track,
  open,
  onClose,
}: {
  track: TrackDTO;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? "");
  const [album, setAlbum] = useState(track.album ?? "");
  const [isPrivate, setIsPrivate] = useState(track.isPrivate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/tracks/${track.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          artist: artist.trim() || null,
          album: album.trim() || null,
          isPrivate,
        }),
      });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500";

  return (
    <Dialog title="Edit track" open={open} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Title
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Artist
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Album
          <input
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="h-4 w-4 accent-emerald-500"
          />
          Private (hidden from friends)
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-neutral-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
