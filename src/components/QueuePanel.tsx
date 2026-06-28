"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { usePlayerStore, type QueueItem } from "@/stores/player";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripIcon,
  XIcon,
} from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import CurrentTrackDetails from "@/components/CurrentTrackDetails";
import { CurrentTrackKebab } from "@/components/TrackList";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";

const EXIT_MS = 100; // matches the animate-*-out durations in globals.css
const DISMISS_PX = 90; // mobile: swipe-down past this (on release) closes the sheet

// Rows above/below the visible window kept mounted so a fast scroll or a drag
// near the edge doesn't flash blank. ~20 rows render regardless of queue size.
const OVERSCAN = 8;
const ROW_FALLBACK = 56; // first-paint estimate; replaced by a real measurement

/**
 * Vertical-list collision: pick the droppable whose center is nearest the
 * dragged item's center on the Y axis only. Same result as `closestCenter` for
 * our restrictToVerticalAxis list, but skips the per-row hypot/X-axis work.
 */
const closestVertical: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  const centerY = collisionRect.top + collisionRect.height / 2;
  let best: { id: (typeof droppableContainers)[number]["id"]; dist: number } | null =
    null;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const dist = Math.abs(rect.top + rect.height / 2 - centerY);
    if (!best || dist < best.dist) best = { id: container.id, dist };
  }
  return best ? [{ id: best.id }] : [];
};

/** The queue list, shown as a desktop popover anchored above the player bar
 *  (`variant="desktop"`) or a mobile fullscreen sheet (`variant="mobile"`);
 *  PlayerBar owns the open state. */
export default memo(function QueuePanel({
  open,
  onClose,
  variant = "desktop",
}: {
  open: boolean;
  onClose: () => void;
  variant?: "desktop" | "mobile";
}) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const { clearUpcoming } = usePlayerStore.getState();
  const mobile = variant === "mobile";
  const current = index >= 0 ? queue[index]?.track ?? null : null;
  // Desktop-only: collapse the list down to just the current-song header.
  const [collapsed, setCollapsed] = useState(false);
  // Desktop popover animates its height as it collapses/expands or the queue
  // resizes: measure the content and transition the wrapper's height to match.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [animHeight, setAnimHeight] = useState<number | undefined>(undefined);
  const [animReady, setAnimReady] = useState(false);
  useEffect(() => {
    if (mobile) return;
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      // Ignore 0 (the panel is display:none while closed) so reopening doesn't
      // animate up from nothing.
      if (h > 0) {
        setAnimHeight(h);
        setAnimReady(true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile]);

  // Windowing: only the visible slice of rows is mounted. The list lives in
  // normal flow between two spacers (no per-row transform), so @dnd-kit's drag
  // animations behave exactly as they do for a fully-rendered list.
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState(ROW_FALLBACK);
  // The dragged row's id; kept so the DragOverlay can render it even after the
  // source row scrolls out of the window and unmounts (auto-scroll on a long drag).
  const [activeId, setActiveId] = useState<string | number | null>(null);

  // Measure a real row height once it's laid out (rows are fixed-height, so one
  // sample is exact); keeps spacer math and the scrollbar honest.
  const measureRow = useCallback((node: HTMLLIElement | null) => {
    if (!node) return;
    const h = node.offsetHeight;
    if (h > 0) setRowH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);

  // A small activation distance lets a plain tap on the grip still register as
  // a click (and lets touch-scrolling the list work) before a drag kicks in.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const { queue, reorder } = usePlayerStore.getState();
    const from = queue.findIndex((q) => q.uid === active.id);
    const to = queue.findIndex((q) => q.uid === over.id);
    if (from !== -1 && to !== -1) reorder(from, to);
  }, []);

  // Mobile sheet: swipe-down-to-close, mirroring NowPlayingScreen. The sheet
  // position is an inline transform so a drag can follow the finger and the
  // open/close slide reuses the same transition. `atRest` => settled at the open
  // position (translateY 0); false => off-screen (100%).
  const [atRest, setAtRest] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragYRef = useRef(0);
  const startYRef = useRef<number | null>(null);

  // Stay mounted briefly after close so the exit animation can play.
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      // Reopening: clear any in-flight close (so its stale unmount timer can't
      // fire mid-slide) and start off-screen so the slide-up plays from the bottom.
      setClosing(false);
      setAtRest(false);
      setDragY(0);
    } else {
      setClosing(true);
    }
  }
  useEffect(() => {
    if (!closing) return;
    // The mobile sheet uses the longer slide-up animation; the desktop popover
    // the quick pop. Keep the node mounted until its exit animation finishes.
    const t = setTimeout(() => setClosing(false), mobile ? 220 : EXIT_MS);
    return () => clearTimeout(t);
  }, [closing, mobile]);

  // Mobile open/close slide: a frame after the sheet is shown, settle to the
  // rest position (up); on close, drop the rest flag (down). The unmount itself
  // is handled by the `closing` timeout above.
  useEffect(() => {
    if (!mobile) return;
    if (open) {
      dragYRef.current = 0;
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setAtRest(true));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    const r = requestAnimationFrame(() => setAtRest(false));
    return () => cancelAnimationFrame(r);
  }, [open, mobile]);

  // Keep the viewport height current (open transition, viewport resize/rotate).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // On open, jump the window to the playing track (not the top of history) by
  // scrolling it to center. Read index/rowH from refs so this fires only on
  // open — not when the track advances while the panel is already open (which
  // would yank a user who has scrolled away).
  const centerRef = useRef({ index, rowH });
  useEffect(() => {
    centerRef.current = { index, rowH };
  });
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      setViewportH(el.clientHeight);
      const { index: i, rowH: rh } = centerRef.current;
      if (i >= 0) el.scrollTop = Math.max(0, i * rh - el.clientHeight / 2 + rh / 2);
      setScrollTop(el.scrollTop);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const upcoming = queue.length - index - 1;
  // Stable across index/isPlaying changes so SortableContext doesn't churn.
  const items = useMemo(() => queue.map((q) => q.uid), [queue]);

  const total = queue.length;
  const visCount = viewportH > 0 ? Math.ceil(viewportH / rowH) : 10;
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(total, first + visCount + OVERSCAN * 2);
  const topPad = first * rowH;
  const bottomPad = Math.max(0, (total - last) * rowH);

  const activeIndex =
    activeId != null ? queue.findIndex((q) => q.uid === activeId) : -1;
  const activeItem = activeIndex >= 0 ? queue[activeIndex] : null;

  // Stay mounted while fully closed (display:none) so the @dnd-kit tree mounts
  // as the queue is built, not in one cold synchronous frame on first open.
  const hidden = !open && !closing;

  const rootChrome = mobile
    ? `${
        hidden ? "hidden" : ""
      } fixed inset-0 z-[60] flex flex-col bg-surface-1 md:hidden`
    : `${
        hidden ? "hidden" : open ? "animate-pop-in" : "animate-pop-out"
      } absolute bottom-full left-2 z-20 mb-2 w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-surface-2 shadow-lg md:left-56`;

  // Off-screen until settled; follows the finger while dragging down (mobile).
  const offset = atRest ? `${dragY}px` : "100%";

  // Swipe-to-close, attached only to the non-list header zones (the handle pill
  // and current-track header) so it can never fight the @dnd-kit row reorder,
  // which lives on the grips inside the scrollable list below.
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => {
      startYRef.current = e.touches[0].clientY;
      setDragging(true);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (startYRef.current == null) return;
      const dy = Math.max(0, e.touches[0].clientY - startYRef.current);
      dragYRef.current = dy;
      setDragY(dy);
    },
    onTouchEnd: () => {
      setDragging(false);
      startYRef.current = null;
      if (dragYRef.current > DISMISS_PX) onClose();
      else setDragY(0);
    },
    // A system-interrupted swipe (iOS edge gesture, incoming call) fires
    // touchcancel, not touchend — reset so it can't pin `dragging` (which would
    // kill the next slide's transition) or strand a past-threshold dragY that a
    // later tap would read as a dismiss.
    onTouchCancel: () => {
      setDragging(false);
      startYRef.current = null;
      dragYRef.current = 0;
      setDragY(0);
    },
  };

  const body = (
    <>
      {mobile && (
        <div
          {...swipe}
          className="flex shrink-0 justify-center pb-1 pt-[calc(env(safe-area-inset-top)+0.75rem)]"
        >
          <div className="h-1.5 w-10 rounded-full bg-white/30" />
        </div>
      )}
      {current && (
        <div
          {...(mobile ? swipe : {})}
          className={`border-b border-border px-4 ${
            mobile ? "pb-3 pt-1" : "pb-3 pt-4"
          }`}
        >
          <CurrentTrackDetails
            track={current}
            row={mobile}
            artSize={mobile ? "h-12 w-12" : "w-full aspect-square"}
            iconSize={mobile ? 22 : 64}
            onNavigate={onClose}
            trailing={<CurrentTrackKebab track={current} onNavigate={onClose} />}
          />
        </div>
      )}

      {!collapsed && (
        <>
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold text-fg">Queue</h2>
            <span className="text-xs text-fg-muted">
              {queue.length} track{queue.length === 1 ? "" : "s"}
            </span>
            <div className="flex-1" />
            {upcoming > 0 && (
              <button
                onClick={clearUpcoming}
                className="text-xs text-fg-muted hover:text-white"
              >
                Clear upcoming
              </button>
            )}
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestVertical}
            modifiers={[restrictToVerticalAxis]}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={(e) => setActiveId(e.active.id)}
            onDragCancel={() => setActiveId(null)}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={items}
              strategy={verticalListSortingStrategy}
            >
              <ul
                ref={scrollRef}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                className={
                  mobile
                    ? "min-h-0 flex-1 overflow-y-auto py-1"
                    : "max-h-[calc(100dvh-40rem)] overflow-y-auto py-1"
                }
              >
                {topPad > 0 && <li aria-hidden style={{ height: topPad }} />}
                {queue.slice(first, last).map((item, i) => {
                  const idx = first + i;
                  return (
                    <QueueRow
                      key={item.uid}
                      item={item}
                      isCurrent={idx === index}
                      isPlaying={idx === index && isPlaying}
                      measureRef={i === 0 ? measureRow : undefined}
                    />
                  );
                })}
                {bottomPad > 0 && (
                  <li aria-hidden style={{ height: bottomPad }} />
                )}
              </ul>
            </SortableContext>

            <DragOverlay>
              {activeItem ? (
                <QueueRowOverlay
                  item={activeItem}
                  isCurrent={activeIndex === index}
                  isPlaying={activeIndex === index && isPlaying}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </>
      )}

      <div
        className={`flex shrink-0 items-center border-t border-border px-4 ${
          mobile
            ? "justify-center pb-[calc(env(safe-area-inset-bottom)+1.75rem)] pt-3"
            : "justify-between py-2"
        }`}
      >
        {!mobile && (
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
            title={collapsed ? "Expand queue" : "Collapse queue"}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-surface-3 hover:text-white"
          >
            {collapsed ? (
              <ChevronUpIcon size={16} />
            ) : (
              <ChevronDownIcon size={16} />
            )}
            {collapsed ? "Expand" : "Collapse"}
          </button>
        )}
        <button
          onClick={onClose}
          aria-label={mobile ? "Back to now playing" : "Close queue"}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-3 hover:text-white"
        >
          {mobile ? (
            <>
              <ChevronDownIcon size={18} />
              Back
            </>
          ) : (
            <>
              <XIcon size={16} />
              Close
            </>
          )}
        </button>
      </div>
    </>
  );

  return (
    <div
      className={rootChrome}
      style={
        mobile
          ? {
              transform: `translateY(${offset})`,
              transition: dragging ? "none" : "transform 0.22s ease",
            }
          : {
              height: animHeight,
              transition: animReady ? "height 200ms ease" : undefined,
            }
      }
    >
      {mobile ? (
        body
      ) : (
        <div ref={contentRef} className="flex flex-col">
          {body}
        </div>
      )}
    </div>
  );
});

const QueueRow = memo(function QueueRow({
  item,
  isCurrent,
  isPlaying,
  measureRef,
}: {
  item: QueueItem;
  isCurrent: boolean;
  isPlaying: boolean;
  measureRef?: (node: HTMLLIElement | null) => void;
}) {
  const { track } = item;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.uid });
  // While dragging, the row is the placeholder gap (the DragOverlay shows the
  // lifted copy). It keeps its sortable transform so it animates to make room
  // with its neighbours, just invisibly.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };

  // Look up the live index at click time (keyed on the stable uid) so handlers
  // stay referentially stable across reorders and keep React.memo effective.
  const onPlay = useCallback(() => {
    const s = usePlayerStore.getState();
    s.playAt(s.queue.findIndex((q) => q.uid === item.uid));
  }, [item.uid]);
  const onRemove = useCallback(() => {
    const s = usePlayerStore.getState();
    s.removeFromQueue(s.queue.findIndex((q) => q.uid === item.uid));
  }, [item.uid]);

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        measureRef?.(node);
      }}
      style={style}
      className={`group flex items-center gap-2 px-4 py-1.5 ${
        isCurrent ? "bg-surface-3/40" : "hover:bg-surface-3/40"
      }`}
    >
      <TrackArt track={track} size="h-10 w-10" iconSize={18} />
      <div className="min-w-0 flex-1">
        <button
          onClick={onPlay}
          disabled={isCurrent}
          title={isCurrent ? undefined : `Play ${track.title}`}
          className={`block max-w-full truncate text-left text-sm font-medium ${
            isCurrent ? "text-accent-bright" : "text-fg"
          }`}
        >
          {track.title}
        </button>
        <p className="truncate text-xs text-fg-muted">
          {track.artist ? (
            <Link
              href={`/artist?name=${encodeURIComponent(track.artist)}`}
              className="hover:text-accent-bright hover:underline"
            >
              {track.artist}
            </Link>
          ) : (
            "Unknown artist"
          )}
          {track.ownerName ? ` · from ${track.ownerName}` : ""}
        </p>
      </div>
      {isCurrent ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright">
          <NowPlayingBars playing={isPlaying} className="h-3 w-3" />
          Playing
        </span>
      ) : (
        <button
          onClick={onRemove}
          aria-label={`Remove ${track.title} from queue`}
          title="Remove from queue"
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
        >
          <XIcon size={14} />
        </button>
      )}
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${track.title}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-white active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100"
      >
        <GripIcon size={16} />
      </button>
    </li>
  );
});

/** The lifted copy shown under the cursor while a row is dragged. Mirrors the
 *  visible parts of a row (the X/grip are hover-only, so omitted) in the
 *  dragging skin the row used to wear inline. */
function QueueRowOverlay({
  item,
  isCurrent,
  isPlaying,
}: {
  item: QueueItem;
  isCurrent: boolean;
  isPlaying: boolean;
}) {
  const { track } = item;
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-3 px-4 py-1.5 shadow-lg">
      <TrackArt track={track} size="h-10 w-10" iconSize={18} />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-sm font-medium ${
            isCurrent ? "text-accent-bright" : "text-fg"
          }`}
        >
          {track.title}
        </p>
        <p className="truncate text-xs text-fg-muted">
          {track.artist || "Unknown artist"}
          {track.ownerName ? ` · from ${track.ownerName}` : ""}
        </p>
      </div>
      {isCurrent && (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright">
          <NowPlayingBars playing={isPlaying} className="h-3 w-3" />
          Playing
        </span>
      )}
      <span className="shrink-0 p-1 text-fg-subtle">
        <GripIcon size={16} />
      </span>
    </div>
  );
}
