"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

function commonValue(
  tracks: TrackDTO[],
  field: "artist" | "album"
): { value: string; mixed: boolean } {
  const firstValue = tracks[0]?.[field] ?? "";
  const mixed = tracks.some(
    (track) => (track[field] ?? "") !== firstValue
  );
  return { value: mixed ? "" : firstValue, mixed };
}

// Stays mounted with tracks=null so Dialog can animate out. The keyed form
// starts with fresh common/mixed values for every new selection.
export default function BulkEditTracksDialog({
  tracks,
  onClose,
  onSaved,
}: {
  tracks: TrackDTO[] | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  return (
    <Dialog
      title={
        tracks
          ? `Edit ${tracks.length} track${tracks.length === 1 ? "" : "s"}`
          : "Edit tracks"
      }
      open={!!tracks}
      onClose={onClose}
    >
      {tracks && (
        <BulkEditTracksForm
          key={tracks.map((track) => track.id).join(",")}
          tracks={tracks}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function BulkEditTracksForm({
  tracks,
  onClose,
  onSaved,
}: {
  tracks: TrackDTO[];
  onClose: () => void;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const initialArtist = commonValue(tracks, "artist");
  const initialAlbum = commonValue(tracks, "album");
  const [artist, setArtist] = useState(initialArtist.value);
  const [album, setAlbum] = useState(initialAlbum.value);
  const [changeArtist, setChangeArtist] = useState(false);
  const [changeAlbum, setChangeAlbum] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changeArtist && !changeAlbum) return;
    setBusy(true);
    setError(null);
    try {
      await api("/tracks/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackIds: tracks.map((track) => track.id),
          ...(changeArtist ? { artist: artist.trim() || null } : {}),
          ...(changeAlbum ? { album: album.trim() || null } : {}),
        }),
      });
      onClose();
      router.refresh();
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tracks");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        Select each field you want to apply to every track. A selected empty
        field clears that value; unselected fields stay unchanged.
      </p>

      <fieldset className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-medium text-fg">
          <input
            type="checkbox"
            checked={changeArtist}
            onChange={(e) => setChangeArtist(e.target.checked)}
            className="checkbox"
          />
          Change artist
        </label>
        <Input
          value={artist}
          maxLength={200}
          placeholder={initialArtist.mixed ? "Multiple artists" : "No artist"}
          aria-label="Artist"
          onChange={(e) => {
            setArtist(e.target.value);
            setChangeArtist(true);
          }}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-medium text-fg">
          <input
            type="checkbox"
            checked={changeAlbum}
            onChange={(e) => setChangeAlbum(e.target.checked)}
            className="checkbox"
          />
          Change album
        </label>
        <Input
          value={album}
          maxLength={200}
          placeholder={initialAlbum.mixed ? "Multiple albums" : "No album"}
          aria-label="Album"
          onChange={(e) => {
            setAlbum(e.target.value);
            setChangeAlbum(true);
          }}
        />
      </fieldset>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || (!changeArtist && !changeAlbum)}
        >
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
