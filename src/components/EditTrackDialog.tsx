"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { log } from "@/lib/log";
import type { TrackDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import TrackArt from "@/components/TrackArt";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

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
      // api() handles the basePath and error extraction; it sets no headers,
      // so the FormData boundary is preserved.
      await api(`/tracks/${track.id}/art`, { method: "POST", body: form });
      setArtPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      router.refresh();
      onSaved?.();
    } catch (err) {
      log.warn(
        "art",
        `upload failed for ${track.id}`,
        err instanceof Error ? err.message : "failed"
      );
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
          <span className="absolute inset-0 flex items-center justify-center rounded bg-black/60 text-[10px] font-medium text-fg opacity-0 transition-opacity group-hover:opacity-100">
            Change
          </span>
        </button>
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => artInputRef.current?.click()}
            disabled={artBusy}
          >
            {artBusy ? "Uploading…" : "Upload album art"}
          </Button>
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
        <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Artist
        <Input value={artist} onChange={(e) => setArtist(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Album
        <Input value={album} onChange={(e) => setAlbum(e.target.value)} />
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
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
