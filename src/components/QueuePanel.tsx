"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  TrashIcon,
  XIcon,
} from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import CurrentTrackDetails from "@/components/CurrentTrackDetails";
import { useMobileSwipeAction } from "@/components/MobileSwipeAction";
import { CurrentTrackKebab } from "@/components/TrackMenus";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";

const EXIT_MS = 100; // matches the animate-*-out durations in globals.css
const DISMISS_PX = 90; // mobile: swipe-down past this (on release) closes the sheet
const DESKTOP_FRAME_KEY = "wt-queue-window";
const FRAME_GAP = 8;
const MIN_FRAME_WIDTH = 320;
const MIN_FRAME_HEIGHT = 260;
const DEFAULT_FRAME_WIDTH = 416;
const DEFAULT_FRAME_HEIGHT = 560;
// Title bar (45px) + the existing 56px current-track art row and its padding.
// Collapsing hides only the upcoming list, not what is currently playing.
const COLLAPSED_FRAME_HEIGHT = 126;

type DesktopFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function clampDesktopFrame(
  frame: DesktopFrame,
  minHeight = MIN_FRAME_HEIGHT
): DesktopFrame {
  const maxWidth = Math.max(1, window.innerWidth - FRAME_GAP * 2);
  const maxHeight = Math.max(1, window.innerHeight - FRAME_GAP * 2);
  const width = Math.min(
    maxWidth,
    Math.max(Math.min(MIN_FRAME_WIDTH, maxWidth), frame.width)
  );
  const height = Math.min(
    maxHeight,
    Math.max(Math.min(minHeight, maxHeight), frame.height)
  );
  return {
    width,
    height,
    x: Math.min(
      window.innerWidth - width - FRAME_GAP,
      Math.max(FRAME_GAP, frame.x)
    ),
    y: Math.min(
      window.innerHeight - height - FRAME_GAP,
      Math.max(FRAME_GAP, frame.y)
    ),
  };
}

function initialDesktopFrame(): DesktopFrame {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(DESKTOP_FRAME_KEY) ?? "null"
    ) as Partial<DesktopFrame> | null;
    if (
      stored &&
      [stored.x, stored.y, stored.width, stored.height].every(Number.isFinite)
    ) {
      return clampDesktopFrame(stored as DesktopFrame);
    }
  } catch {
    // Unavailable/corrupt localStorage: use the normal player-bar anchor.
  }
  const width = Math.min(
    DEFAULT_FRAME_WIDTH,
    window.innerWidth - FRAME_GAP * 2
  );
  const height = Math.min(
    DEFAULT_FRAME_HEIGHT,
    window.innerHeight - FRAME_GAP * 2
  );
  return clampDesktopFrame({
    x: 232,
    y: window.innerHeight - height - 80,
    width,
    height,
  });
}

function saveDesktopFrame(frame: DesktopFrame) {
  try {
    window.localStorage.setItem(DESKTOP_FRAME_KEY, JSON.stringify(frame));
  } catch {
    // Window geometry is a convenience; storage failures are harmless.
  }
}

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
  // Desktop-only floating-window geometry. QueuePanel is dynamically imported
  // with ssr:false, so this initializer can safely restore the previous frame.
  const [desktopFrame, setDesktopFrame] = useState<DesktopFrame | null>(() =>
    mobile ? null : initialDesktopFrame()
  );
  // Desktop-only: minimize the window down to its draggable title bar.
  const [collapsed, setCollapsed] = useState(false);
  const expandedHeightRef = useRef(DEFAULT_FRAME_HEIGHT);
  const frameInteractionRef = useRef<{
    pointerId: number;
    kind: "move" | "resize";
    startX: number;
    startY: number;
    startFrame: DesktopFrame;
    lastFrame: DesktopFrame;
  } | null>(null);

  // A viewport resize must never strand the floating window off-screen.
  useEffect(() => {
    if (mobile) return;
    const onResize = () =>
      setDesktopFrame((frame) =>
        frame
          ? clampDesktopFrame(
              frame,
              collapsed ? COLLAPSED_FRAME_HEIGHT : MIN_FRAME_HEIGHT
            )
          : frame
      );
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [collapsed, mobile]);

  const beginFrameInteraction = useCallback(
    (event: React.PointerEvent<HTMLElement>, kind: "move" | "resize") => {
      if (mobile || event.button !== 0 || !desktopFrame) return;
      if (
        kind === "move" &&
        event.target instanceof Element &&
        event.target.closest("button:not([data-drag-handle])")
      ) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      frameInteractionRef.current = {
        pointerId: event.pointerId,
        kind,
        startX: event.clientX,
        startY: event.clientY,
        startFrame: desktopFrame,
        lastFrame: desktopFrame,
      };
    },
    [desktopFrame, mobile]
  );

  const moveFrameInteraction = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const interaction = frameInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      const next = clampDesktopFrame(
        interaction.kind === "move"
          ? {
              ...interaction.startFrame,
              x: interaction.startFrame.x + dx,
              y: interaction.startFrame.y + dy,
            }
          : {
              ...interaction.startFrame,
              width: interaction.startFrame.width + dx,
              height: interaction.startFrame.height + dy,
            },
        collapsed ? COLLAPSED_FRAME_HEIGHT : MIN_FRAME_HEIGHT
      );
      interaction.lastFrame = next;
      setDesktopFrame(next);
    },
    [collapsed]
  );

  const endFrameInteraction = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const interaction = frameInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      frameInteractionRef.current = null;
      saveDesktopFrame(interaction.lastFrame);
    },
    []
  );

  const nudgeDesktopFrame = useCallback(
    (dx: number, dy: number, resize = false) => {
      setDesktopFrame((frame) => {
        if (!frame) return frame;
        const next = clampDesktopFrame(
          resize
            ? { ...frame, width: frame.width + dx, height: frame.height + dy }
            : { ...frame, x: frame.x + dx, y: frame.y + dy },
          collapsed ? COLLAPSED_FRAME_HEIGHT : MIN_FRAME_HEIGHT
        );
        saveDesktopFrame(next);
        return next;
      });
    },
    [collapsed]
  );

  const toggleCollapsed = useCallback(() => {
    setDesktopFrame((frame) => {
      if (!frame) return frame;
      if (collapsed) {
        return clampDesktopFrame({
          ...frame,
          height: expandedHeightRef.current,
        });
      }
      expandedHeightRef.current = frame.height;
      return { ...frame, height: COLLAPSED_FRAME_HEIGHT };
    });
    setCollapsed((value) => !value);
  }, [collapsed]);

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
  // open - not when the track advances while the panel is already open (which
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
        hidden
          ? "hidden"
          : `${open ? "animate-pop-in" : "animate-pop-out"} hidden md:flex`
      } fixed z-[55] min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface-2 shadow-2xl`;

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
    // touchcancel, not touchend - reset so it can't pin `dragging` (which would
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
      {!mobile && (
        <div
          onPointerDown={(event) => beginFrameInteraction(event, "move")}
          onPointerMove={moveFrameInteraction}
          onPointerUp={endFrameInteraction}
          onPointerCancel={endFrameInteraction}
          onDoubleClick={toggleCollapsed}
          className="flex h-[45px] shrink-0 cursor-move select-none items-center gap-2 border-b border-border bg-surface-1 px-2.5"
        >
          <button
            type="button"
            data-drag-handle
            aria-label="Move queue window"
            title="Drag to move queue"
            onKeyDown={(event) => {
              const step = event.shiftKey ? 32 : 8;
              const delta =
                event.key === "ArrowLeft"
                  ? [-step, 0]
                  : event.key === "ArrowRight"
                    ? [step, 0]
                    : event.key === "ArrowUp"
                      ? [0, -step]
                      : event.key === "ArrowDown"
                        ? [0, step]
                        : null;
              if (!delta) return;
              event.preventDefault();
              nudgeDesktopFrame(delta[0], delta[1]);
            }}
            className="flex h-8 w-8 shrink-0 cursor-move items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <GripIcon size={16} />
          </button>
          <h2 className="text-sm font-semibold text-fg">Queue</h2>
          <span className="text-xs text-fg-muted">
            {queue.length} track{queue.length === 1 ? "" : "s"}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={toggleCollapsed}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={collapsed ? "Restore queue window" : "Minimize queue window"}
            title={collapsed ? "Restore queue" : "Minimize queue"}
            className="flex h-8 w-8 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            {collapsed ? (
              <ChevronUpIcon size={16} />
            ) : (
              <ChevronDownIcon size={16} />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label="Close queue"
            title="Close queue"
            className="flex h-8 w-8 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <XIcon size={16} />
          </button>
        </div>
      )}
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
            mobile ? "pb-3 pt-1" : "py-3"
          }`}
        >
          <CurrentTrackDetails
            track={current}
            row
            artSize={mobile ? "h-12 w-12" : "h-14 w-14"}
            iconSize={mobile ? 22 : 24}
            onNavigate={onClose}
            trailing={<CurrentTrackKebab track={current} onNavigate={onClose} />}
          />
        </div>
      )}

      {!collapsed && (
        <>
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold text-fg">
              {mobile ? "Queue" : "Up next"}
            </h2>
            {mobile && (
              <>
                <span className="text-xs text-fg-muted">
                  {queue.length} track{queue.length === 1 ? "" : "s"}
                </span>
                <span className="text-[10px] text-fg-subtle">
                  Swipe left to remove
                </span>
              </>
            )}
            <div className="flex-1" />
            {upcoming > 0 && (
              <button
                onClick={clearUpcoming}
                className="text-xs text-fg-muted hover:text-fg"
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
                  "min-h-0 flex-1 overflow-y-auto py-1"
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

            {typeof document !== "undefined" &&
              createPortal(
                <DragOverlay>
                  {activeItem ? (
                    <QueueRowOverlay
                      item={activeItem}
                      isCurrent={activeIndex === index}
                      isPlaying={activeIndex === index && isPlaying}
                    />
                  ) : null}
                </DragOverlay>,
                document.body
              )}
          </DndContext>
        </>
      )}

      {mobile && (
        <div className="flex shrink-0 items-center justify-center border-t border-border px-4 pb-[calc(env(safe-area-inset-bottom)+1.75rem)] pt-3">
          <button
            onClick={onClose}
            aria-label="Back to now playing"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <ChevronDownIcon size={18} />
            Back
          </button>
        </div>
      )}
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
              left: desktopFrame?.x,
              top: desktopFrame?.y,
              width: desktopFrame?.width,
              height: desktopFrame?.height,
            }
      }
    >
      {mobile ? (
        body
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {body}
        </div>
      )}
      {!mobile && !collapsed && (
        <button
          type="button"
          aria-label="Resize queue window"
          title="Drag to resize queue"
          onPointerDown={(event) => beginFrameInteraction(event, "resize")}
          onPointerMove={moveFrameInteraction}
          onPointerUp={endFrameInteraction}
          onPointerCancel={endFrameInteraction}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 32 : 8;
            const delta =
              event.key === "ArrowLeft"
                ? [-step, 0]
                : event.key === "ArrowRight"
                  ? [step, 0]
                  : event.key === "ArrowUp"
                    ? [0, -step]
                    : event.key === "ArrowDown"
                      ? [0, step]
                      : null;
            if (!delta) return;
            event.preventDefault();
            nudgeDesktopFrame(delta[0], delta[1], true);
          }}
          className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-se-resize touch-none rounded-tl text-fg-subtle hover:bg-surface-3 hover:text-fg"
        >
          <span className="absolute bottom-1 right-1 block h-2.5 w-2.5 border-b-2 border-r-2 border-current" />
        </button>
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
  const swipe = useMobileSwipeAction<HTMLDivElement>(onRemove, {
    disabled: isCurrent,
    direction: "left",
  });

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        measureRef?.(node);
      }}
      style={style}
      className="group relative isolate overflow-hidden"
    >
      {!isCurrent && (
        <div
          aria-hidden
          style={{ opacity: swipe.progress }}
          className="absolute inset-0 flex items-center justify-end bg-red-500/85 px-5 text-white md:hidden"
        >
          <span
            className={`inline-flex transition-transform duration-100 ease-out ${
              swipe.committed ? "scale-125" : ""
            }`}
          >
            <TrashIcon size={20} />
          </span>
        </div>
      )}
      <div
        {...swipe.handlers}
        style={swipe.foregroundStyle}
        className={`relative z-[1] flex items-center gap-2 px-4 py-1.5 ${
          isCurrent
            ? "bg-surface-3"
            : "bg-surface-1 hover:bg-surface-3/80 md:bg-surface-2"
        }`}
      >
        <TrackArt track={track} size="h-10 w-10" iconSize={18} thumb />
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
                className="hover:text-accent-bright"
              >
                {track.artist}
              </Link>
            ) : (
              "Unknown artist"
            )}
            {track.ownerName ? (
              <>
                {" · from "}
                <Link
                  href={`/discover/${track.ownerId}`}
                  className="hover:text-accent-bright"
                >
                  {track.ownerName}
                </Link>
              </>
            ) : null}
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
            className="sr-only shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-red-400 md:not-sr-only md:flex md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
          >
            <XIcon size={14} />
          </button>
        )}
        <button
          {...attributes}
          {...listeners}
          data-swipe-ignore
          aria-label={`Reorder ${track.title}`}
          title="Drag to reorder"
          className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
        >
          <GripIcon size={16} />
        </button>
      </div>
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
      <TrackArt track={track} size="h-10 w-10" iconSize={18} thumb />
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
