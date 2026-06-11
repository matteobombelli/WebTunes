"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  UpIcon,
  XIcon,
} from "@/components/icons";
import EditTrackDialog from "@/components/EditTrackDialog";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "–:––";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type SortKey = "title" | "artist" | "album" | "duration";
type SortState = { key: SortKey; dir: 1 | -1 } | null;

// U+FFFF sentinel sorts null fields after real values (ascending).
const NULL_SENTINEL = "￿";

function sortTracks(tracks: TrackDTO[], sort: SortState): TrackDTO[] {
  if (!sort) return tracks;
  const copy = [...tracks];
  copy.sort((a, b) => {
    if (sort.key === "duration") {
      return ((a.durationSec ?? -1) - (b.durationSec ?? -1)) * sort.dir;
    }
    const av = a[sort.key] ?? NULL_SENTINEL;
    const bv = b[sort.key] ?? NULL_SENTINEL;
    return (
      av.localeCompare(bv, undefined, { sensitivity: "base" }) * sort.dir
    );
  });
  return copy;
}

function AddToPlaylistMenu({
  trackIds,
  align = "right",
  bulk = false,
  onAdded,
}: {
  trackIds: string[];
  align?: "left" | "right";
  /** Bulk style: labeled button and per-count feedback. */
  bulk?: boolean;
  onAdded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Keeps the menu mounted briefly after close so it can animate out.
  const [menuClosing, setMenuClosing] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistDTO[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    if (open) {
      setOpen(false);
      setMenuClosing(true);
      setTimeout(() => setMenuClosing(false), 150);
      return;
    }
    setOpen(true);
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
      const res = await api<{ added: number }>(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds }),
      });
      setMessage(bulk ? `Added ${res.added}` : "Added");
      if (onAdded) setTimeout(onAdded, 600);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="relative">
      {bulk ? (
        <button
          onClick={load}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          Add to playlist
        </button>
      ) : (
        <button
          onClick={load}
          aria-label="Add to playlist"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
          title="Add to playlist"
        >
          <PlusIcon size={16} />
        </button>
      )}
      {(open || menuClosing) && (
        <div
          className={`${open ? "animate-pop-in" : "animate-pop-out"} absolute ${align === "left" ? "left-0" : "right-0"} z-10 mt-1 w-44 rounded-md border border-neutral-700 bg-neutral-800 py-1 text-sm shadow-lg`}
        >
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
  canEdit = false,
  selectable = false,
  sortable = false,
  onRemove,
  removeLabel,
  onMove,
  onMutated,
}: {
  tracks: TrackDTO[];
  showOwner?: boolean;
  /** Shows the delete action on the viewer's own tracks. */
  canDelete?: boolean;
  /** Shows the edit (pencil) action on the viewer's own tracks. */
  canEdit?: boolean;
  /** Enables checkbox multi-select with a bulk add-to-playlist bar. */
  selectable?: boolean;
  /** Enables click-to-sort column headers (library view). */
  sortable?: boolean;
  /** Custom remove handler (e.g. remove from playlist instead of deleting). */
  onRemove?: (track: TrackDTO) => Promise<void>;
  removeLabel?: string;
  /** Enables reorder arrows (playlist view). */
  onMove?: (track: TrackDTO, direction: -1 | 1) => Promise<void>;
  /** Called after a track is deleted or edited (for client-state parents). */
  onMutated?: () => void;
}) {
  const router = useRouter();
  const playQueue = usePlayerStore((s) => s.playQueue);
  const current = useCurrentTrack();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TrackDTO | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(null);

  // Display order; the play queue and bulk-add follow it.
  const view = useMemo(
    () => (sortable ? sortTracks(tracks, sort) : tracks),
    [tracks, sortable, sort]
  );

  // Click cycles: ascending → descending → default (server order).
  const cycleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key !== key
        ? { key, dir: 1 }
        : prev.dir === 1
          ? { key, dir: -1 }
          : null
    );

  const sortHeader = (key: SortKey, label: React.ReactNode) =>
    sortable ? (
      <button
        onClick={() => cycleSort(key)}
        className="inline-flex items-center uppercase hover:text-neutral-300"
      >
        {label}
        {/* Fixed-width slot so the chevron never shifts the label. */}
        <span className="inline-flex w-3.5 justify-center">
          {sort?.key === key &&
            (sort.dir === 1 ? (
              <ChevronUpIcon size={11} />
            ) : (
              <ChevronDownIcon size={11} />
            ))}
        </span>
      </button>
    ) : (
      label
    );

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Selection can hold ids of tracks that were since deleted (router.refresh
  // keeps client state) — only count ids present in the current list.
  const validSelected = useMemo(() => {
    const ids = new Set(tracks.map((t) => t.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [tracks, selected]);
  const allSelected = validSelected.size === tracks.length && tracks.length > 0;
  // The bar shows the last real count while fading out, never "0 selected".
  const [lastSelectedCount, setLastSelectedCount] = useState(0);
  if (validSelected.size > 0 && validSelected.size !== lastSelectedCount) {
    setLastSelectedCount(validSelected.size);
  }
  const [bulkBusy, setBulkBusy] = useState(false);

  const remove = async (track: TrackDTO) => {
    if (
      !onRemove &&
      !confirm(`Are you sure you want to delete "${track.title}"?`)
    ) {
      return;
    }
    setBusyId(track.id);
    try {
      if (onRemove) await onRemove(track);
      else await api(`/tracks/${track.id}`, { method: "DELETE" });
      router.refresh();
      onMutated?.();
    } finally {
      setBusyId(null);
    }
  };

  // Only the viewer's own tracks can be deleted; a selection made in a
  // shared view (search, friends) may also contain friends' tracks.
  const deletableSelectedIds = useMemo(
    () =>
      view
        .filter((t) => validSelected.has(t.id) && !t.ownerName)
        .map((t) => t.id),
    [view, validSelected]
  );

  const bulkDelete = async () => {
    const ids = deletableSelectedIds;
    const noun = `${ids.length} song${ids.length === 1 ? "" : "s"}`;
    if (!confirm(`Are you sure you want to delete ${noun}?`)) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        ids.map((id) => api(`/tracks/${id}`, { method: "DELETE" }))
      );
      setSelected(new Set());
      router.refresh();
      onMutated?.();
    } finally {
      setBulkBusy(false);
    }
  };

  if (tracks.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-500">No tracks here yet.</p>;
  }

  return (
    <>
    {/* Space is always reserved so selecting doesn't shift the table. */}
    {selectable && (
      <div
        className={`mb-3 flex h-11 items-center gap-3 rounded-md border px-4 transition-all duration-200 ${
          validSelected.size > 0
            ? "border-neutral-700 bg-neutral-800/60 opacity-100"
            : "pointer-events-none border-transparent opacity-0"
        }`}
      >
        <span className="text-sm text-neutral-300">
          {lastSelectedCount} selected
        </span>
        <AddToPlaylistMenu
          bulk
          align="left"
          trackIds={view.filter((t) => validSelected.has(t.id)).map((t) => t.id)}
          onAdded={() => setSelected(new Set())}
        />
        {canDelete && deletableSelectedIds.length > 0 && (
          <button
            onClick={bulkDelete}
            disabled={bulkBusy}
            className="rounded-md px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            {bulkBusy ? "Deleting…" : "Delete"}
          </button>
        )}
        <button
          onClick={() => setSelected(new Set())}
          className="text-xs text-neutral-400 hover:text-white"
        >
          Clear
        </button>
      </div>
    )}
    {/* Fixed layout: column widths come from the <th>s, so long values
        truncate instead of resizing columns. */}
    <table className="w-full table-fixed text-left text-sm">
      <thead className="text-xs uppercase text-neutral-500">
        <tr className="border-b border-neutral-800">
          {selectable && (
            <th className="w-8 py-2">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(tracks.map((t) => t.id))
                  )
                }
                className="checkbox"
              />
            </th>
          )}
          <th className="py-2">{sortHeader("title", "Title")}</th>
          <th className="hidden w-[18%] py-2 sm:table-cell">
            {sortHeader("artist", "Artist")}
          </th>
          <th className="hidden w-[18%] py-2 md:table-cell">
            {sortHeader("album", "Album")}
          </th>
          {showOwner && (
            <th className="hidden w-24 py-2 md:table-cell">Owner</th>
          )}
          <th className="w-14 py-2 text-right">{sortHeader("duration", "⏱")}</th>
          <th className={`${onMove ? "w-32" : "w-24"} py-2`}></th>
        </tr>
      </thead>
      <tbody>
        {view.map((track, i) => {
          const isCurrent = current?.id === track.id;
          return (
            <tr
              key={track.id}
              className={`group border-b border-neutral-800/60 transition-colors hover:bg-neutral-800/40 ${
                isCurrent ? "text-emerald-400" : "text-neutral-200"
              }`}
            >
              {selectable && (
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${track.title}`}
                    checked={validSelected.has(track.id)}
                    onChange={() => toggleSelected(track.id)}
                    className="checkbox"
                  />
                </td>
              )}
              <td className="py-2">
                <button
                  onClick={() => playQueue(view, i)}
                  title={`Play ${track.title}`}
                  className="flex w-full items-center gap-1.5 text-left font-medium hover:text-emerald-400 hover:underline"
                >
                  <span className="truncate">{track.title}</span>
                  {track.isPrivate && !track.ownerName && (
                    <LockIcon size={12} className="shrink-0 text-neutral-500" />
                  )}
                </button>
              </td>
              <td className="hidden truncate py-2 pr-2 text-neutral-400 sm:table-cell">
                {track.artist ?? "—"}
              </td>
              <td className="hidden truncate py-2 pr-2 text-neutral-400 md:table-cell">
                {track.album ?? "—"}
              </td>
              {showOwner && (
                <td className="hidden truncate py-2 pr-2 text-neutral-400 md:table-cell">
                  {track.ownerName ?? "You"}
                </td>
              )}
              <td className="py-2 text-right tabular-nums text-neutral-400">
                {formatDuration(track.durationSec)}
              </td>
              <td className="py-2">
                <div className="flex items-center justify-end gap-1 md:opacity-0 md:group-hover:opacity-100">
                  {onMove && (
                    <>
                      <button
                        onClick={() => onMove(track, -1)}
                        disabled={i === 0}
                        aria-label="Move up"
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white disabled:opacity-30"
                      >
                        <UpIcon size={14} />
                      </button>
                      <button
                        onClick={() => onMove(track, 1)}
                        disabled={i === view.length - 1}
                        aria-label="Move down"
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white disabled:opacity-30"
                      >
                        <DownIcon size={14} />
                      </button>
                    </>
                  )}
                  {canEdit && !track.ownerName && (
                    <button
                      onClick={() => setEditing(track)}
                      aria-label="Edit track"
                      title="Edit track"
                      className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
                    >
                      <PencilIcon size={15} />
                    </button>
                  )}
                  <AddToPlaylistMenu trackIds={[track.id]} />
                  {(onRemove || (canDelete && !track.ownerName)) && (
                    <button
                      onClick={() => remove(track)}
                      disabled={busyId === track.id}
                      aria-label={removeLabel ?? "Delete track"}
                      title={removeLabel ?? "Delete track"}
                      className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-red-400 disabled:opacity-50"
                    >
                      <XIcon size={16} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    <EditTrackDialog
      track={editing}
      onClose={() => setEditing(null)}
      onSaved={onMutated}
    />
    </>
  );
}
