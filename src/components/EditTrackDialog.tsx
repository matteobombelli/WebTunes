"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type { TrackDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import TrackArt from "@/components/TrackArt";

// Stays mounted with track=null so the Dialog can animate out; the inner
// form mounts per track (keyed) so its state starts fresh each time.
export default function EditTrackDialog({
  track,
  onClose,
  onSaved,
}: {
  track: TrackDTO | null;
  onClose: () => void;
  /** Called after a successful save (for parents holding client state). */
  onSaved?: () => void;
}) {
  return (
    <Dialog title="Edit track" open={!!track} onClose={onClose}>
      {track && (
        <EditTrackForm
          key={track.id}
          track={track}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function EditTrackForm({
  track,
  onClose,
  onSaved,
}: {
  track: TrackDTO;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? "");
  const [album, setAlbum] = useState(track.album ?? "");
  const [isPrivate, setIsPrivate] = useState(track.isPrivate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const artInputRef = useRef<HTMLInputElement>(null);
  // Local preview of a just-uploaded image: the stable /art URL doesn't change
  // on replacement, so a fresh object URL gives instant feedback in the dialog.
  const [artPreview, setArtPreview] = useState<string | null>(null);
  const [artBusy, setArtBusy] = useState(false);
  const [artError, setArtError] = useState<string | null>(null);

  const uploadArt = async (file: File | undefined) => {
    if (!file) return;
    setArtBusy(true);
    setArtError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${BASE_PATH}/api/tracks/${track.id}/art`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Upload failed (${res.status})`);
      }
      setArtPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      router.refresh();
      onSaved?.();
    } catch (err) {
      setArtError(err instanceof Error ? err.message : "Failed to upload art");
    } finally {
      setArtBusy(false);
    }
  };

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
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded-md border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => artInputRef.current?.click()}
          title="Change album art"
          className="group relative shrink-0"
        >
          {artPreview ? (
            // Local object URL of the just-uploaded file.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={artPreview}
              alt=""
              className="h-16 w-16 rounded object-cover"
            />
          ) : (
            <TrackArt track={track} size="h-16 w-16" iconSize={28} thumb />
          )}
          <span className="absolute inset-0 hidden items-center justify-center rounded bg-black/60 text-[10px] font-medium text-white group-hover:flex">
            Change
          </span>
        </button>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => artInputRef.current?.click()}
            disabled={artBusy}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg hover:border-fg-muted disabled:opacity-50"
          >
            {artBusy ? "Uploading…" : "Upload album art"}
          </button>
          {artError && <p className="text-xs text-red-400">{artError}</p>}
        </div>
      </div>
      <input
        ref={artInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => uploadArt(e.target.files?.[0])}
      />
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Title
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Artist
        <input
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Album
        <input
          value={album}
          onChange={(e) => setAlbum(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="mt-1 flex items-center gap-2 text-sm text-fg-muted">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(e) => setIsPrivate(e.target.checked)}
          className="checkbox"
        />
        Private (hidden from friends)
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm text-fg-muted hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
