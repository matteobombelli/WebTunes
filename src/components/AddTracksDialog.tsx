"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import TrackArt from "@/components/TrackArt";

// Stays mounted so the Dialog can animate out; the body mounts per open so
// the filter and selection start fresh each time.
export default function AddTracksDialog({
  playlistId,
  existingTrackIds,
  open,
  onClose,
}: {
  playlistId: string;
  existingTrackIds: string[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog title="Add songs" open={open} onClose={onClose} wide>
      {open && (
        <AddTracksBody
          playlistId={playlistId}
          existingTrackIds={existingTrackIds}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function AddTracksBody({
  playlistId,
  existingTrackIds,
  onClose,
}: {
  playlistId: string;
  existingTrackIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [all, setAll] = useState<TrackDTO[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<TrackDTO[]>("/tracks?scope=all")
      .then((tracks) => {
        if (!cancelled) setAll(tracks);
      })
      .catch(() => {
        if (!cancelled) setAll([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = useMemo(() => {
    if (!all) return null;
    const existing = new Set(existingTrackIds);
    const f = filter.trim().toLowerCase();
    return all
      .filter((t) => !existing.has(t.id))
      .filter(
        (t) =>
          !f ||
          t.title.toLowerCase().includes(f) ||
          t.artist?.toLowerCase().includes(f) ||
          t.album?.toLowerCase().includes(f)
      );
  }, [all, existingTrackIds, filter]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: [...selected] }),
      });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tracks");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by title, artist, or album"
        className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="max-h-80 overflow-y-auto rounded-md border border-border-subtle">
        {candidates === null && (
          <p className="p-4 text-sm text-fg-subtle">Loading…</p>
        )}
        {candidates?.length === 0 && (
          <p className="p-4 text-sm text-fg-subtle">
            No more songs available to add.
          </p>
        )}
        {candidates?.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 border-b border-border-subtle/60 px-3 py-2 text-sm last:border-b-0 hover:bg-surface-2/40"
          >
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => toggle(t.id)}
              className="checkbox shrink-0"
            />
            <TrackArt track={t} size="h-9 w-9" iconSize={16} thumb />
            <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
            <span className="hidden max-w-32 truncate text-fg-muted sm:block">
              {t.artist ?? "—"}
            </span>
            <span className="shrink-0 text-xs text-fg-subtle">
              {t.ownerName ?? "You"}
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm text-fg-muted hover:text-white"
        >
          Cancel
        </button>
        <button
          onClick={addSelected}
          disabled={busy || selected.size === 0}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {busy
            ? "Adding…"
            : `Add ${selected.size} song${selected.size === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
