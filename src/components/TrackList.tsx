"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  DownloadIcon,
  GripIcon,
  HeadphonesIcon,
  LockIcon,
  PencilIcon,
  PlayNextIcon,
  QueueIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons";
import EditTrackDialog from "@/components/EditTrackDialog";
import BulkEditTracksDialog from "@/components/BulkEditTracksDialog";
import { useMobileSwipeAction } from "@/components/MobileSwipeAction";
import TrackArt from "@/components/TrackArt";
import { AddToPlaylistMenu, TrackActionsMenu } from "@/components/TrackMenus";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";
import { useConfirmStore } from "@/stores/confirm";
import { useDownloadsStore } from "@/stores/downloads";
import { useToastStore } from "@/stores/toast";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "–:––";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// How many rows to render initially and to add each time the scroll sentinel
// comes into view.
const PAGE_SIZE = 50;
// Where the swipe-to-queue icon sits, measured from the row's resting left edge.
const ICON_INSET = 16;

type SortKey = "title" | "artist" | "album" | "owner" | "duration" | "plays";
type SortState = { key: SortKey; dir: 1 | -1 } | null;

// U+FFFF sentinel sorts null fields after real values (ascending).
const NULL_SENTINEL = "￿";

// "owner" maps to ownerName (own tracks show as "You"), not a direct field.
function sortText(
  t: TrackDTO,
  key: "title" | "artist" | "album" | "owner"
): string {
  if (key === "owner") return t.ownerName ?? "You";
  return t[key] ?? NULL_SENTINEL;
}

function sortTracks(tracks: TrackDTO[], sort: SortState): TrackDTO[] {
  if (!sort) return tracks;
  const copy = [...tracks];
  copy.sort((a, b) => {
    if (sort.key === "duration") {
      return ((a.durationSec ?? -1) - (b.durationSec ?? -1)) * sort.dir;
    }
    if (sort.key === "plays") {
      return (a.friendPlayCount - b.friendPlayCount) * sort.dir;
    }
    return (
      sortText(a, sort.key).localeCompare(sortText(b, sort.key), undefined, {
        sensitivity: "base",
      }) * sort.dir
    );
  });
  return copy;
}


// The "Select…" / "Reorder" mode toggles above the table.
const MODE_TOGGLE_BTN =
  "flex h-11 items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-4 text-sm font-semibold text-fg-muted hover:bg-surface-3 hover:text-fg";

// A labeled action in the bulk-selection bar.
const BULK_BAR_BTN =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40";

// The per-row queue actions: hover-revealed on desktop, but also revealed for
// keyboard users (focus-visible / any focus inside the row).
const ROW_HOVER_BTN =
  "hidden h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg md:flex md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100";

type TrackRowProps = {
  track: TrackDTO;
  index: number;
  view: TrackDTO[];
  isCurrent: boolean;
  /** Only meaningful when isCurrent; false otherwise so non-current rows stay
   *  referentially stable and skip re-render on play/pause. */
  isPlaying: boolean;
  selectable: boolean;
  /** Whether the checkbox column is expanded (selection mode active). */
  selectMode: boolean;
  selected: boolean;
  showOwner: boolean;
  canEdit: boolean;
  canDelete: boolean;
  playQueue: (tracks: TrackDTO[], startIndex: number) => number;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onRemove?: (track: TrackDTO) => Promise<void>;
  removeLabel?: string;
  onEdit: (track: TrackDTO) => void;
  onDelete: (track: TrackDTO) => void;
};

// Memoized so playback-state changes (current track, play/pause) re-render only
// the affected rows, not every visible row in a long library.
const TrackRow = memo(function TrackRow({
  track,
  index,
  view,
  isCurrent,
  isPlaying,
  selectable,
  selectMode,
  selected,
  showOwner,
  canEdit,
  canDelete,
  playQueue,
  onToggleSelect,
  onRemove,
  removeLabel,
  onEdit,
  onDelete,
}: TrackRowProps) {
  const playNext = useCallback(() => {
    usePlayerStore.getState().playNext([track]);
  }, [track]);
  const swipe = useMobileSwipeAction<HTMLTableRowElement>(playNext);

  return (
    <tr
      {...swipe.handlers}
      style={{
        ...swipe.foregroundStyle,
        animationDelay: `${Math.min(index, 8) * 0.03}s`,
      }}
      className={`group animate-fade-in-up border-b border-border-subtle/60 transition-colors hover:bg-surface-2/40 ${
        isCurrent ? "text-accent-bright" : "text-fg"
      }`}
    >
      {selectable && (
        <td className="overflow-hidden py-2">
          <input
            type="checkbox"
            aria-label={`Select ${track.title}`}
            checked={selected}
            // React backs checkbox onChange with the native click, so the
            // nativeEvent carries shiftKey - used for range selection.
            onChange={(e) =>
              onToggleSelect(track.id, (e.nativeEvent as MouseEvent).shiftKey)
            }
            tabIndex={selectMode ? 0 : -1}
            className={`checkbox transition-[opacity,transform] duration-200 ${
              selectMode
                ? "translate-x-0 opacity-100"
                : "pointer-events-none -translate-x-2 opacity-0"
            }`}
          />
        </td>
      )}
      <td className="relative py-2.5 sm:py-2">
        {/* A <tr> can hold no backdrop layer of its own, so the swipe's action
            colour is painted from the first cell: a fixed-width panel whose
            right edge is pinned to the cell, so it rides the row's transform
            and uncovers the strip the row opens up. Everything it overhangs
            past the row's starting edge is off-screen. Nothing here is sized
            from the offset - width is a layout property, and animating it per
            touch frame is what made this feel heavier than the queue's exit.
            (A box-shadow on the row would not paint at all - the table
            inherits `border-collapse: collapse` from the Tailwind preflight.) */}
        <span
          aria-hidden
          style={swipe.backdropStyle}
          className="pointer-events-none absolute inset-y-0 right-full w-32 overflow-hidden bg-green-500 text-white md:hidden"
        >
          {/* Counter-translated by the row's own offset, so it holds still at
              ICON_INSET from where the row started while the panel slides out
              from under it - the same reveal the queue's trash icon gets from
              sitting in a backdrop that never moves. Shares the foreground's
              transition so the two stay in lockstep on the way back. */}
          <span
            className="absolute inset-y-0 left-full flex items-center"
            style={{
              transform: `translate3d(${ICON_INSET - swipe.offset}px, 0, 0)`,
              transition: swipe.foregroundStyle.transition,
            }}
          >
            {/* Own element: the wrapper's transition would otherwise replace
                this one's, snapping the pop instead of easing it. */}
            <span
              className={`inline-flex transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                swipe.committed ? "scale-125" : ""
              }`}
            >
              <PlayNextIcon size={22} />
            </span>
          </span>
        </span>
        <button
          onClick={() => playQueue(view, index)}
          title={`Play ${track.title}`}
          className="flex w-full items-center gap-2 text-left font-medium hover:text-accent-bright"
        >
          <span className="relative shrink-0">
            <TrackArt track={track} size="h-11 w-11 sm:h-9 sm:w-9" iconSize={18} thumb />
            {isCurrent && (
              <span className="absolute inset-0 flex items-center justify-center rounded bg-black/45 text-accent-bright">
                <NowPlayingBars playing={isPlaying} />
              </span>
            )}
          </span>
          <span className="truncate text-base sm:text-sm">{track.title}</span>
          {track.isPrivate && !track.ownerName && (
            <LockIcon size={12} className="shrink-0 text-fg-subtle" />
          )}
        </button>
      </td>
      <td className="hidden truncate py-2 pr-2 text-fg-muted sm:table-cell">
        {track.artist ? (
          <Link
            href={`/artist?name=${encodeURIComponent(track.artist)}`}
            className="hover:text-accent-bright"
          >
            {track.artist}
          </Link>
        ) : (
          "-"
        )}
      </td>
      <td className="hidden truncate py-2 pr-2 text-fg-muted md:table-cell">
        {track.album ? (
          <Link
            href={`/album?name=${encodeURIComponent(track.album)}`}
            className="hover:text-accent-bright"
          >
            {track.album}
          </Link>
        ) : (
          "-"
        )}
      </td>
      {showOwner && (
        <td className="hidden truncate py-2 pr-2 text-fg-muted md:table-cell">
          {track.ownerName ? (
            <Link
              href={`/discover/${track.ownerId}`}
              className="hover:text-accent-bright"
            >
              {track.ownerName}
            </Link>
          ) : (
            "You"
          )}
        </td>
      )}
      <td className="py-2.5 text-center tabular-nums text-fg-muted sm:py-2">
        {formatDuration(track.durationSec)}
      </td>
      <td className="hidden py-2 text-center tabular-nums text-fg-muted md:table-cell">
        {track.friendPlayCount}
      </td>
      <td className="py-2">
        <div className="flex items-center justify-end gap-0.5">
          {/* Desktop: single-click queue actions, revealed on row hover (and on
              keyboard focus, so tab stops are never invisible). */}
          <button
            onClick={() => usePlayerStore.getState().playNext([track])}
            aria-label="Play next"
            title="Play next"
            className={ROW_HOVER_BTN}
          >
            <PlayNextIcon size={20} />
          </button>
          <button
            onClick={() => usePlayerStore.getState().addToQueue([track])}
            aria-label="Add to queue"
            title="Add to queue"
            className={ROW_HOVER_BTN}
          >
            <QueueIcon size={20} />
          </button>
          {/* Kebab dropdown for both layouts: hover-revealed on desktop, always
              shown on mobile (where it also hosts Play next / Add to queue). */}
          <TrackActionsMenu
            track={track}
            canEdit={canEdit}
            canDelete={canDelete}
            onRemove={onRemove}
            removeLabel={removeLabel}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </td>
    </tr>
  );
});

// A stripped sortable row for reorder mode (grip + art + title/artist only),
// mirroring the player queue's QueueRow. The whole table's row chrome (play,
// checkbox, kebab) is intentionally dropped here - reordering is the one job.
const ReorderRow = memo(function ReorderRow({ track }: { track: TrackDTO }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : undefined,
      }}
      className="flex items-center gap-3 border-b border-border-subtle/60 py-2 pr-1"
    >
      <TrackArt track={track} size="h-11 w-11 sm:h-9 sm:w-9" iconSize={18} thumb />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium sm:text-sm">{track.title}</p>
        <p className="truncate text-xs text-fg-muted">{track.artist ?? "-"}</p>
      </div>
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${track.title}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg active:cursor-grabbing"
      >
        <GripIcon size={18} />
      </button>
    </li>
  );
});

// The drag-and-drop list shown in reorder mode. Self-contained @dnd-kit context
// (like QueuePanel) so the normal table stays untouched; all rows are mounted
// (no windowing - playlists are small) so SortableContext can measure them.
function ReorderableTrackList({
  tracks,
  onDragEnd,
}: {
  tracks: TrackDTO[];
  onDragEnd: (e: DragEndEvent) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    // A small activation distance keeps a tap distinct from a drag (and lets the
    // page still scroll from a touch that starts on the grip).
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const items = useMemo(() => tracks.map((t) => t.id), [tracks]);
  const active = activeId ? tracks.find((t) => t.id === activeId) ?? null : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={(e) => {
        setActiveId(null);
        onDragEnd(e);
      }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <ul>
          {tracks.map((t) => (
            <ReorderRow key={t.id} track={t} />
          ))}
        </ul>
      </SortableContext>
      <DragOverlay>
        {active ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 py-2 pl-1 pr-1 shadow-lg">
            <TrackArt
              track={active}
              size="h-11 w-11 sm:h-9 sm:w-9"
              iconSize={18}
              thumb
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-medium sm:text-sm">
                {active.title}
              </p>
              <p className="truncate text-xs text-fg-muted">
                {active.artist ?? "-"}
              </p>
            </div>
            <span className="shrink-0 p-1 text-fg-subtle">
              <GripIcon size={18} />
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default function TrackList({
  tracks,
  showOwner = false,
  canDelete = false,
  canEdit = false,
  canBulkEdit = false,
  selectable = false,
  sortable = false,
  onRemove,
  removeLabel,
  onReorder,
  onMutated,
  emptyMessage,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  prepareSort,
  loadCompleteCollection,
}: {
  tracks: TrackDTO[];
  showOwner?: boolean;
  /** Shows the delete action on the viewer's own tracks. */
  canDelete?: boolean;
  /** Shows the edit (pencil) action on the viewer's own tracks. */
  canEdit?: boolean;
  /** Shows bulk artist/album editing for selected owned tracks. */
  canBulkEdit?: boolean;
  /** Enables checkbox multi-select with a bulk add-to-playlist bar. */
  selectable?: boolean;
  /** Enables click-to-sort column headers. */
  sortable?: boolean;
  /** Custom remove handler (e.g. remove from playlist instead of deleting). */
  onRemove?: (track: TrackDTO) => Promise<void>;
  removeLabel?: string;
  /** Enables a drag-to-reorder mode (playlist view); persists the new order. */
  onReorder?: (trackIds: string[]) => Promise<void>;
  /** Called after a track is deleted or edited (for client-state parents). */
  onMutated?: () => void;
  /** Replaces the default "No tracks here yet." empty state (e.g. searches). */
  emptyMessage?: string;
  /** More server-side pages exist beyond the tracks currently supplied. */
  hasMore?: boolean;
  /** A remote page request is currently in flight. */
  loadingMore?: boolean;
  /** Fetches the next server-side page as the list sentinel approaches. */
  onLoadMore?: () => void;
  /** Ensures a remotely-paginated collection is complete before a local sort. */
  prepareSort?: () => Promise<boolean>;
  /**
   * Returns the complete remotely-paginated collection. Playback starts from
   * the supplied page immediately, then uses this to expand the active queue.
   */
  loadCompleteCollection?: () => Promise<TrackDTO[] | null>;
}) {
  const router = useRouter();
  const storePlayQueue = usePlayerStore((s) => s.playQueue);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const current = useCurrentTrack();
  const [editing, setEditing] = useState<TrackDTO | null>(null);
  const [bulkEditing, setBulkEditing] = useState<TrackDTO[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection is opt-in: checkboxes and the bulk bar stay hidden behind a
  // "Select…" button until the user turns this on (Clear turns it back off).
  const [selectMode, setSelectMode] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const [preparingSort, setPreparingSort] = useState<SortKey | null>(null);

  const playQueue = useCallback(
    (queueTracks: TrackDTO[], startIndex: number) => {
      const session = storePlayQueue(queueTracks, startIndex);
      if (loadCompleteCollection) {
        void loadCompleteCollection()
          .then((complete) => {
            if (complete) {
              usePlayerStore
                .getState()
                .completeCollection(session, complete);
            }
          })
          .catch(() => {
            // Best-effort: the paginated queue already started and remains
            // usable. Background completion failures are intentionally silent.
          });
      }
      return session;
    },
    [loadCompleteCollection, storePlayQueue]
  );

  // Drag-to-reorder is opt-in like select, and mutually exclusive with it. Only
  // offered when a persist handler is wired; entering it clears any active sort
  // so the visual order is the true server order the reorder PUT permutation wants.
  const reorderable = !!onReorder && tracks.length > 1;
  const [reorderMode, setReorderMode] = useState(false);
  // Optimistic order during a drag; re-synced whenever the parent passes a fresh
  // `tracks` array (e.g. after router.refresh). Render-phase reset, like prevView.
  const [order, setOrder] = useState(tracks);
  const [prevTracks, setPrevTracks] = useState(tracks);
  if (tracks !== prevTracks) {
    setPrevTracks(tracks);
    setOrder(tracks);
  }

  // Display order; the play queue and bulk-add follow it.
  const view = useMemo(
    () => (sortable ? sortTracks(tracks, sort) : tracks),
    [tracks, sortable, sort]
  );

  // Render rows incrementally so a 1000+ track library doesn't mount every
  // row at once. Sort/search/selection still run over the full `view`; only
  // the rendered slice grows, extended as a sentinel near the end scrolls in.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Reset for a different/re-sorted list, but retain the window when a remote
  // page is appended so scrolling does not jump back to the first 50 rows.
  // Render-phase reset per react.dev "storing information from previous renders".
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    const isAppend =
      prevView.length <= view.length &&
      prevView.every((track, index) => view[index]?.id === track.id);
    setPrevView(view);
    if (!isAppend) setVisibleCount(PAGE_SIZE);
  }
  const visible = useMemo(() => view.slice(0, visibleCount), [view, visibleCount]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canRevealLocalRows = visibleCount < view.length;
    const canFetchRemoteRows = hasMore && !loadingMore && !!onLoadMore;
    if (!canRevealLocalRows && !canFetchRemoteRows) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          if (canRevealLocalRows) {
            setVisibleCount((c) => Math.min(c + PAGE_SIZE, view.length));
          } else {
            onLoadMore?.();
          }
        }
      },
      { rootMargin: "800px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadingMore, onLoadMore, visibleCount, view.length]);

  // Click cycles: ascending → descending → default (server order). A local
  // sort must not run over only the currently-loaded keyset page; the library
  // view uses prepareSort to fetch its complete current scope first.
  const cycleSort = async (key: SortKey) => {
    if (preparingSort) return;
    const next: SortState =
      sort?.key !== key
        ? { key, dir: 1 }
        : sort.dir === 1
          ? { key, dir: -1 }
          : null;
    if (next && prepareSort) {
      setPreparingSort(key);
      const ready = await prepareSort().finally(() => setPreparingSort(null));
      if (!ready) return;
    }
    setSort(next);
  };

  // If an active sort survives a data refresh that reintroduces pagination,
  // restore the complete collection automatically instead of silently sorting
  // only the refreshed first page.
  useEffect(() => {
    if (sort && hasMore && prepareSort && !preparingSort) {
      void prepareSort();
    }
  }, [hasMore, prepareSort, preparingSort, sort]);

  const ariaSort = (key: SortKey) =>
    sortable && sort?.key === key
      ? sort.dir === 1
        ? ("ascending" as const)
        : ("descending" as const)
      : undefined;

  const sortHeader = (key: SortKey, label: React.ReactNode) =>
    sortable ? (
      <button
        onClick={() => void cycleSort(key)}
        disabled={preparingSort !== null}
        aria-busy={preparingSort === key}
        className="relative inline-flex items-center uppercase hover:text-fg-muted disabled:cursor-default disabled:opacity-70"
      >
        {label}
        {/* Positioned outside the flow so the chevron never shifts the label -
            keeps the centered icon columns (duration, plays) truly centered. */}
        {preparingSort === key ? (
          <span className="absolute inset-y-0 left-full flex w-4 items-center justify-center">
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-surface-3 border-r-accent-bright border-t-accent-bright shadow-[0_0_8px_rgb(129_140_248/0.35)]"
            />
            <span className="sr-only">Preparing sort</span>
          </span>
        ) : sort?.key === key ? (
          <span className="absolute inset-y-0 left-full flex w-3.5 items-center justify-center">
            {sort.dir === 1 ? (
              <ChevronUpIcon size={11} />
            ) : (
              <ChevronDownIcon size={11} />
            )}
          </span>
        ) : null}
      </button>
    ) : (
      label
    );

  // The last plainly-clicked row, used as the anchor for a shift+click range.
  const rangeAnchorRef = useRef<string | null>(null);
  const toggleSelected = useCallback(
    (id: string, shiftKey: boolean) => {
      const anchor = rangeAnchorRef.current;
      // Shift+click selects every row between the anchor and this one
      // (inclusive), in display order - no anchor yet falls through to a plain
      // toggle. The anchor stays put so the range can be re-extended.
      if (shiftKey && anchor && anchor !== id) {
        const from = view.findIndex((t) => t.id === anchor);
        const to = view.findIndex((t) => t.id === id);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelected((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(view[i].id);
            return next;
          });
          return;
        }
      }
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      rangeAnchorRef.current = id;
    },
    [view]
  );
  // Selection can hold ids of tracks that were since deleted (router.refresh
  // keeps client state) - only count ids present in the current list.
  const validSelected = useMemo(() => {
    const ids = new Set(tracks.map((t) => t.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [tracks, selected]);
  const allSelected = validSelected.size === tracks.length && tracks.length > 0;
  const [bulkBusy, setBulkBusy] = useState(false);

  // Leaving select mode clears the selection too, so the bar and checkboxes
  // animate out together and re-entering starts fresh.
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  // Apply a drag reorder optimistically, then persist; the parent's
  // router.refresh reconciles (and reverts the order on a rejected PUT).
  const handleReorder = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = order.findIndex((t) => t.id === active.id);
      const to = order.findIndex((t) => t.id === over.id);
      if (from === -1 || to === -1) return;
      const next = arrayMove(order, from, to);
      setOrder(next);
      onReorder?.(next.map((t) => t.id));
    },
    [order, onReorder]
  );

  const remove = useCallback(
    async (track: TrackDTO) => {
      if (!onRemove) {
        const ok = await useConfirmStore
          .getState()
          .ask(`Delete “${track.title}”? This can’t be undone.`, {
            confirmLabel: "Delete",
          });
        if (!ok) return;
      }
      try {
        if (onRemove) await onRemove(track);
        else await api(`/tracks/${track.id}`, { method: "DELETE" });
      } catch {
        useToastStore
          .getState()
          .show(onRemove ? "Couldn’t remove track" : "Couldn’t delete track");
        return;
      }
      router.refresh();
      onMutated?.();
    },
    [onRemove, router, onMutated]
  );

  // Only the viewer's own tracks can be deleted; a selection made in a
  // shared view (search, friends) may also contain friends' tracks.
  const deletableSelectedIds = useMemo(
    () =>
      view
        .filter((t) => validSelected.has(t.id) && !t.ownerName)
        .map((t) => t.id),
    [view, validSelected]
  );
  const editableSelectedTracks = useMemo(
    () =>
      view.filter((track) => validSelected.has(track.id) && !track.ownerName),
    [view, validSelected]
  );

  const bulkDelete = async () => {
    const ids = deletableSelectedIds;
    const noun = `${ids.length} song${ids.length === 1 ? "" : "s"}`;
    const ok = await useConfirmStore
      .getState()
      .ask(`Delete ${noun}? This can’t be undone.`, { confirmLabel: "Delete" });
    if (!ok) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        ids.map((id) => api(`/tracks/${id}`, { method: "DELETE" }))
      );
      setSelected(new Set());
    } catch {
      useToastStore.getState().show("Couldn’t delete some tracks");
    } finally {
      setBulkBusy(false);
      router.refresh();
      onMutated?.();
    }
  };

  // Bulk variant of the per-row `onRemove` (e.g. remove-from-playlist). Runs
  // sequentially, not Promise.all: the playlist remove endpoint re-compacts
  // positions in a transaction, so concurrent removes would race on the
  // overlapping position updates.
  const bulkRemove = async () => {
    if (!onRemove) return;
    const targets = view.filter((t) => validSelected.has(t.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      for (const t of targets) await onRemove(t);
      setSelected(new Set());
    } catch {
      useToastStore.getState().show("Couldn’t remove some tracks");
    } finally {
      setBulkBusy(false);
      router.refresh();
      onMutated?.();
    }
  };

  if (tracks.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-fg-muted">
        {emptyMessage ?? "No tracks here yet."}
      </p>
    );
  }

  return (
    <>
    {/* The h-11 slot is always reserved so toggling never shifts the table; it
        cross-fades between three mutually-exclusive layers: the default toggles
        (Select… / Reorder), the bulk-actions bar (select mode), and the reorder
        bar (reorder mode). */}
    {(selectable || reorderable) && (
      <div className="relative mb-3 h-11">
        <div
          className={`absolute inset-0 flex items-center gap-2 transition-opacity duration-150 ${
            !selectMode && !reorderMode
              ? "opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          {selectable && (
            <button
              onClick={() => {
                setSelectMode(true);
                setReorderMode(false);
              }}
              className={MODE_TOGGLE_BTN}
            >
              <CheckIcon size={16} />
              Select…
            </button>
          )}
          {reorderable && (
            <button
              onClick={() => {
                setSort(null);
                setReorderMode(true);
                exitSelectMode();
              }}
              className={MODE_TOGGLE_BTN}
            >
              <GripIcon size={16} />
              Reorder
            </button>
          )}
        </div>
        <div
          className={`absolute inset-0 flex items-center gap-3 overflow-x-auto rounded-md border px-4 transition-opacity duration-150 ${
            selectMode
              ? "border-border bg-surface-2/60 opacity-100"
              : "pointer-events-none border-transparent opacity-0"
          }`}
        >
          <span className="shrink-0 whitespace-nowrap text-sm text-fg-muted">
            {validSelected.size} selected
          </span>
          <div className="shrink-0">
            <AddToPlaylistMenu
              bulk
              align="left"
              trackIds={view.filter((t) => validSelected.has(t.id)).map((t) => t.id)}
              onAdded={() => setSelected(new Set())}
            />
          </div>
          <button
            onClick={() => {
              usePlayerStore
                .getState()
                .addToQueue(view.filter((t) => validSelected.has(t.id)));
              setSelected(new Set());
            }}
            disabled={validSelected.size === 0}
            aria-label="Add to queue"
            title="Add to queue"
            className={`${BULK_BAR_BTN} text-fg-muted hover:bg-surface-3`}
          >
            <QueueIcon size={18} />
            <span className="hidden md:inline">Add to queue</span>
          </button>
          <button
            onClick={() => {
              useDownloadsStore
                .getState()
                .enqueue(view.filter((t) => validSelected.has(t.id)), { pin: true });
              setSelected(new Set());
            }}
            disabled={validSelected.size === 0}
            aria-label="Download"
            title="Download"
            className={`${BULK_BAR_BTN} text-fg-muted hover:bg-surface-3`}
          >
            <DownloadIcon size={18} />
            <span className="hidden md:inline">Download</span>
          </button>
          {canBulkEdit && (
            <button
              onClick={() => setBulkEditing(editableSelectedTracks)}
              disabled={bulkBusy || editableSelectedTracks.length === 0}
              aria-label="Edit artist and album"
              title="Edit artist and album"
              className={`${BULK_BAR_BTN} text-fg-muted hover:bg-surface-3`}
            >
              <PencilIcon size={18} />
              <span>Edit</span>
            </button>
          )}
          {onRemove ? (
            <button
              onClick={bulkRemove}
              disabled={bulkBusy || validSelected.size === 0}
              aria-label={removeLabel ?? "Remove"}
              title={removeLabel ?? "Remove"}
              className={`${BULK_BAR_BTN} text-red-400 hover:bg-red-500/10`}
            >
              <TrashIcon size={18} />
              <span className="hidden md:inline">
                {bulkBusy ? "Removing…" : "Remove"}
              </span>
            </button>
          ) : canDelete ? (
            <button
              onClick={bulkDelete}
              disabled={bulkBusy || deletableSelectedIds.length === 0}
              aria-label="Delete"
              title="Delete"
              className={`${BULK_BAR_BTN} text-red-400 hover:bg-red-500/10`}
            >
              <TrashIcon size={18} />
              <span className="hidden md:inline">
                {bulkBusy ? "Deleting…" : "Delete"}
              </span>
            </button>
          ) : null}
          <button
            onClick={exitSelectMode}
            aria-label="Clear selection"
            title="Clear selection"
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-fg-muted hover:text-fg"
          >
            <XIcon size={18} />
            <span className="hidden md:inline">Clear</span>
          </button>
        </div>
        <div
          className={`absolute inset-0 flex items-center gap-3 rounded-md border px-4 transition-opacity duration-150 ${
            reorderMode
              ? "border-border bg-surface-2/60 opacity-100"
              : "pointer-events-none border-transparent opacity-0"
          }`}
        >
          <span className="shrink-0 whitespace-nowrap text-sm text-fg-muted">
            Drag to reorder
          </span>
          <button
            onClick={() => setReorderMode(false)}
            className="ml-auto flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-4 text-xs font-semibold text-accent-fg hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    )}
    {reorderMode ? (
      <ReorderableTrackList tracks={order} onDragEnd={handleReorder} />
    ) : (
      <>
    {/* Fixed layout: column widths come from the <th>s, so long values
        truncate instead of resizing columns. */}
    <table className="w-full table-fixed text-left text-sm">
      <thead className="text-xs uppercase text-fg-subtle">
        <tr className="border-b border-border-subtle">
          {selectable && (
            <th
              className={`overflow-hidden py-2 transition-[width] duration-200 ${
                selectMode ? "w-8" : "w-0"
              }`}
            >
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(tracks.map((t) => t.id))
                  )
                }
                tabIndex={selectMode ? 0 : -1}
                className={`checkbox transition-[opacity,transform] duration-200 ${
                  selectMode
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none -translate-x-2 opacity-0"
                }`}
              />
            </th>
          )}
          <th className="py-2" aria-sort={ariaSort("title")}>
            {sortHeader("title", "Title")}
          </th>
          <th
            className="hidden w-[18%] py-2 sm:table-cell"
            aria-sort={ariaSort("artist")}
          >
            {sortHeader("artist", "Artist")}
          </th>
          <th
            className="hidden w-[18%] py-2 md:table-cell"
            aria-sort={ariaSort("album")}
          >
            {sortHeader("album", "Album")}
          </th>
          {showOwner && (
            <th
              className="hidden w-24 py-2 md:table-cell"
              aria-sort={ariaSort("owner")}
            >
              {sortHeader("owner", "Owner")}
            </th>
          )}
          <th className="w-14 py-2 text-center" aria-sort={ariaSort("duration")}>
            {sortHeader(
              "duration",
              <span
                title="Duration"
                className="inline-flex items-center justify-center align-middle"
              >
                <ClockIcon size={16} />
              </span>
            )}
          </th>
          <th
            className="hidden w-14 py-2 text-center md:table-cell"
            aria-sort={ariaSort("plays")}
          >
            {sortHeader(
              "plays",
              <span
                title="Listen count"
                className="inline-flex items-center justify-center align-middle"
              >
                <HeadphonesIcon size={16} />
              </span>
            )}
          </th>
          {/* Mobile shows just the kebab; desktop adds Play next + Add to
              queue icons, so reserve more width there. */}
          <th className="w-10 py-2 md:w-28"></th>
        </tr>
      </thead>
      <tbody>
        {visible.map((track, i) => (
          <TrackRow
            key={track.id}
            track={track}
            index={i}
            view={view}
            isCurrent={current?.id === track.id}
            isPlaying={current?.id === track.id ? isPlaying : false}
            selectable={selectable}
            selectMode={selectMode}
            selected={validSelected.has(track.id)}
            showOwner={showOwner}
            canEdit={canEdit}
            canDelete={canDelete}
            playQueue={playQueue}
            onToggleSelect={toggleSelected}
            onRemove={onRemove}
            removeLabel={removeLabel}
            onEdit={setEditing}
            onDelete={remove}
          />
        ))}
      </tbody>
    </table>
    {/* Sentinel lives outside the table so its width has no effect on the
        fixed table column layout; it extends the rendered window on scroll. */}
    {(visibleCount < view.length || hasMore) && (
      <div ref={sentinelRef} aria-hidden className="py-4 text-center text-xs text-fg-subtle">
        {loadingMore ? "Loading more…" : "More tracks below"}
      </div>
    )}
      </>
    )}
    <EditTrackDialog
      track={editing}
      onClose={() => setEditing(null)}
      onSaved={onMutated}
    />
    <BulkEditTracksDialog
      tracks={bulkEditing}
      onClose={() => setBulkEditing(null)}
      onSaved={() => {
        setSelected(new Set());
        onMutated?.();
      }}
    />
    </>
  );
}
