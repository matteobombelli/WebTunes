"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { usePlayerStore } from "@/stores/player";
import { ChevronDownIcon, GripIcon, XIcon } from "@/components/icons";
import CurrentTrackDetails from "@/components/CurrentTrackDetails";
import { QueueRow, QueueRowOverlay } from "@/components/QueueRow";
import { CurrentTrackKebab } from "@/components/TrackMenus";
import {
  clampDesktopFrame,
  COLLAPSED_FRAME_EXTRA_HEIGHT,
  DEFAULT_FRAME_HEIGHT,
  type DesktopFrame,
  initialDesktopFrame,
  MIN_FRAME_HEIGHT,
  RESIZE_HANDLES,
  type ResizeDirection,
  resizeDesktopFrame,
  saveDesktopFrame,
} from "@/components/queue-frame";

const EXIT_MS = 100; // matches the animate-*-out durations in globals.css
const DISMISS_PX = 90; // mobile: swipe-down past this (on release) closes the sheet
const COLLAPSE_TRANSITION_MS = 280;
const COLLAPSE_CONTENT_MS = 100;

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
  // Desktop-only: collapse the queue list into the large now-playing card.
  const [collapsed, setCollapsed] = useState(false);
  const [collapseMotion, setCollapseMotion] = useState<
    "idle" | "collapsing" | "expanding"
  >("idle");
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseLayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  // The compact and artwork-first current-track layouts are deliberately
  // separate from the target state so the queue can fade before they swap.
  const [cardCollapsed, setCardCollapsed] = useState(false);
  const expandedHeightRef = useRef(DEFAULT_FRAME_HEIGHT);
  const desktopBodyRef = useRef<HTMLDivElement | null>(null);
  const frameInteractionRef = useRef<{
    pointerId: number;
    kind: "move" | "resize";
    resizeDirection?: ResizeDirection;
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
              collapsed ? 1 : MIN_FRAME_HEIGHT
            )
          : frame
      );
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [collapsed, mobile]);

  const beginFrameInteraction = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      interaction: "move" | ResizeDirection
    ) => {
      if (mobile || event.button !== 0 || !desktopFrame) return;
      if (
        interaction === "move" &&
        event.target instanceof Element &&
        event.target.closest("button:not([data-drag-handle])")
      ) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      frameInteractionRef.current = {
        pointerId: event.pointerId,
        kind: interaction === "move" ? "move" : "resize",
        resizeDirection:
          interaction === "move" ? undefined : interaction,
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
      const next =
        interaction.kind === "move"
          ? clampDesktopFrame(
              {
                ...interaction.startFrame,
                x: interaction.startFrame.x + dx,
                y: interaction.startFrame.y + dy,
              },
              collapsed ? 1 : MIN_FRAME_HEIGHT
            )
          : resizeDesktopFrame(
              interaction.startFrame,
              interaction.resizeDirection ?? "se",
              dx,
              dy
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
      saveDesktopFrame(
        collapsed
          ? { ...interaction.lastFrame, height: expandedHeightRef.current }
          : interaction.lastFrame
      );
    },
    [collapsed]
  );

  const nudgeDesktopFrame = useCallback(
    (dx: number, dy: number) => {
      setDesktopFrame((frame) => {
        if (!frame) return frame;
        const next = clampDesktopFrame(
          { ...frame, x: frame.x + dx, y: frame.y + dy },
          collapsed ? 1 : MIN_FRAME_HEIGHT
        );
        saveDesktopFrame(
          collapsed ? { ...next, height: expandedHeightRef.current } : next
        );
        return next;
      });
    },
    [collapsed]
  );

  const nudgeDesktopResize = useCallback(
    (direction: ResizeDirection, dx: number, dy: number) => {
      setDesktopFrame((frame) => {
        if (!frame) return frame;
        const next = resizeDesktopFrame(frame, direction, dx, dy);
        saveDesktopFrame(next);
        return next;
      });
    },
    []
  );

  const toggleCollapsed = useCallback(() => {
    const nextCollapsed = !collapsed;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    setDesktopFrame((frame) => {
      if (!frame) return frame;
      if (!nextCollapsed) {
        return clampDesktopFrame({
          ...frame,
          height: expandedHeightRef.current,
        });
      }
      expandedHeightRef.current = frame.height;
      const estimatedHeight = frame.width + COLLAPSED_FRAME_EXTRA_HEIGHT;
      return clampDesktopFrame({ ...frame, height: estimatedHeight }, 1);
    });
    setCollapsed(nextCollapsed);
    if (collapseLayoutTimerRef.current) {
      clearTimeout(collapseLayoutTimerRef.current);
    }
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    if (reduceMotion) {
      setCardCollapsed(nextCollapsed);
      setCollapseMotion("idle");
      collapseLayoutTimerRef.current = null;
      collapseTimerRef.current = null;
      return;
    }
    setCollapseMotion(nextCollapsed ? "collapsing" : "expanding");
    if (nextCollapsed) {
      collapseLayoutTimerRef.current = setTimeout(() => {
        setCardCollapsed(true);
        collapseLayoutTimerRef.current = null;
      }, COLLAPSE_CONTENT_MS);
    } else {
      setCardCollapsed(false);
      collapseLayoutTimerRef.current = null;
    }
    collapseTimerRef.current = setTimeout(() => {
      setCollapseMotion("idle");
      collapseTimerRef.current = null;
    }, COLLAPSE_TRANSITION_MS);
  }, [collapsed]);

  useEffect(
    () => () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      if (collapseLayoutTimerRef.current) {
        clearTimeout(collapseLayoutTimerRef.current);
      }
    },
    []
  );

  // The restored square art makes the collapsed card's height width-dependent,
  // while owner metadata can add another line. Measure the real card so it is
  // never clipped and clamp the corrected frame back into the viewport.
  useEffect(() => {
    if (mobile || !collapsed || !cardCollapsed) return;
    const node = desktopBodyRef.current;
    if (!node) return;
    const syncHeight = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height <= 0) return;
      setDesktopFrame((frame) => {
        if (!frame || Math.abs(frame.height - height) < 1) return frame;
        const next = clampDesktopFrame({ ...frame, height }, height);
        return next.height === frame.height && next.y === frame.y ? frame : next;
      });
    };
    const frame = requestAnimationFrame(syncHeight);
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [cardCollapsed, collapsed, current?.id, mobile]);

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
  // Keep the list mounted just long enough to animate it away. On expansion it
  // mounts immediately and its entrance animation runs alongside the frame.
  const showQueueContent =
    mobile || !collapsed || collapseMotion === "collapsing";

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
      } fixed z-[55] min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface-2 shadow-2xl ${
        collapseMotion === "idle" ? "" : "queue-frame-transition"
      }`;

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
            <ChevronDownIcon
              size={16}
              className={`transition-transform duration-300 ease-out ${
                collapsed ? "rotate-180" : ""
              }`}
            />
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
          key={mobile ? "mobile" : cardCollapsed ? "collapsed" : "expanded"}
          {...(mobile ? swipe : {})}
          className={`border-b border-border px-4 ${
            mobile ? "pb-3 pt-1" : cardCollapsed ? "pb-3 pt-4" : "py-3"
          } ${
            cardCollapsed && collapseMotion === "collapsing"
              ? "animate-queue-current-collapse"
              : !cardCollapsed && collapseMotion === "expanding"
                ? "animate-queue-current-expand"
                : ""
          }`}
        >
          <CurrentTrackDetails
            track={current}
            row={mobile || !cardCollapsed}
            artSize={
              mobile
                ? "h-12 w-12"
                : cardCollapsed
                  ? "aspect-square w-full"
                  : "h-14 w-14"
            }
            iconSize={mobile ? 22 : cardCollapsed ? 64 : 24}
            onNavigate={onClose}
            trailing={<CurrentTrackKebab track={current} onNavigate={onClose} />}
          />
        </div>
      )}

      {showQueueContent && (
        <div
          aria-hidden={!mobile && collapsed}
          inert={!mobile && collapsed ? true : undefined}
          className={`flex min-h-0 flex-1 flex-col ${
            collapseMotion === "collapsing"
              ? "animate-queue-content-collapse"
              : collapseMotion === "expanding"
                ? "animate-queue-content-expand"
                : ""
          }`}
        >
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
        </div>
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
        <div
          ref={desktopBodyRef}
          className={`flex min-h-0 flex-col ${
            cardCollapsed ? "shrink-0" : "h-full"
          }`}
        >
          {body}
        </div>
      )}
      {!mobile &&
        !collapsed &&
        RESIZE_HANDLES.map(({ direction, label, className }) => (
          <button
            key={direction}
            type="button"
            aria-label={`Resize queue from ${label}`}
            title={`Drag to resize from ${label}`}
            onPointerDown={(event) => beginFrameInteraction(event, direction)}
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
              nudgeDesktopResize(direction, delta[0], delta[1]);
            }}
            className={`absolute z-20 touch-none rounded-sm hover:bg-accent/20 focus-visible:bg-accent/25 ${className}`}
          >
            {direction === "se" && (
              <span className="pointer-events-none absolute bottom-1 right-1 block h-2 w-2 border-b-2 border-r-2 border-fg-subtle" />
            )}
          </button>
        ))}
    </div>
  );
});
