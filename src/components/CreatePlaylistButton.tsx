"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";

export default function CreatePlaylistButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setName("");
    setError(null);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const playlist = await api<PlaylistDTO>("/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      router.push(`/playlists/${playlist.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create playlist");
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
      >
        New playlist
      </button>
      <Dialog title="New playlist" open={open} onClose={close}>
        <form onSubmit={create} className="flex flex-col gap-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md px-4 py-2 text-sm text-neutral-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
