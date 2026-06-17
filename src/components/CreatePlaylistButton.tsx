"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

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
      <Button onClick={() => setOpen(true)}>New playlist</Button>
      <Dialog title="New playlist" open={open} onClose={close}>
        <form onSubmit={create} className="flex flex-col gap-4">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
