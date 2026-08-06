"use client";

import {
  type CSSProperties,
  type TouchEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PlayNextIcon } from "@/components/icons";
import type { TrackDTO } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import { useToastStore } from "@/stores/toast";

const START_PX = 7;
const COMMIT_PX = 72;
const MAX_PX = 112;
const SETTLE_MS = 120;

type SwipeOptions = {
  disabled?: boolean;
  /** CSS selector for controls that keep ownership of their touch gesture. */
  ignoreSelector?: string;
};

/**
 * Direction-locked, touch-only swipe-right gesture. Vertical intent is handed
 * back to native scrolling; a completed swipe suppresses the synthetic click
 * browsers otherwise dispatch after touchend.
 */
export function useMobileSwipeAction<T extends HTMLElement>(
  onAction: () => void,
  { disabled = false, ignoreSelector = "[data-swipe-ignore]" }: SwipeOptions = {}
) {
  const actionRef = useRef(onAction);
  useEffect(() => {
    actionRef.current = onAction;
  }, [onAction]);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const [committed, setCommitted] = useState(false);
  const offsetRef = useRef(0);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    axis: "pending" | "horizontal" | "cancelled";
  } | null>(null);
  const suppressClickRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const updateOffset = useCallback((next: number) => {
    offsetRef.current = next;
    setOffset(next);
  }, []);

  const reset = useCallback(() => {
    gestureRef.current = null;
    setSettling(true);
    setCommitted(false);
    updateOffset(0);
    timersRef.current.push(
      window.setTimeout(() => {
        setSettling(false);
        suppressClickRef.current = false;
      }, SETTLE_MS)
    );
  }, [updateOffset]);

  const onTouchStart: TouchEventHandler<T> = useCallback(
    (event) => {
      clearTimers();
      if (
        disabled ||
        event.touches.length !== 1 ||
        !window.matchMedia("(max-width: 767px)").matches ||
        (event.target instanceof Element &&
          !!event.target.closest(ignoreSelector))
      ) {
        gestureRef.current = null;
        return;
      }
      const touch = event.touches[0];
      // Preserve the iOS system back gesture at the physical screen edge.
      if (touch.clientX < 18) {
        gestureRef.current = null;
        return;
      }
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        axis: "pending",
      };
      suppressClickRef.current = false;
      setSettling(false);
      setCommitted(false);
      updateOffset(0);
    },
    [clearTimers, disabled, ignoreSelector, updateOffset]
  );

  const onTouchMove: TouchEventHandler<T> = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;

      if (gesture.axis === "pending") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < START_PX) return;
        // Leftward motion belongs to horizontal carousels; vertical motion
        // belongs to page/list scrolling. Only a clear rightward intent wins.
        if (dx <= 0 || Math.abs(dy) >= Math.abs(dx)) {
          gesture.axis = "cancelled";
          return;
        }
        gesture.axis = "horizontal";
      }
      if (gesture.axis !== "horizontal") return;

      if (event.cancelable) event.preventDefault();
      suppressClickRef.current = true;
      const resisted =
        dx <= COMMIT_PX ? dx : COMMIT_PX + (dx - COMMIT_PX) * 0.28;
      updateOffset(Math.max(0, Math.min(MAX_PX, resisted)));
    },
    [updateOffset]
  );

  const onTouchEnd: TouchEventHandler<T> = useCallback(() => {
    const gesture = gestureRef.current;
    if (gesture?.axis === "horizontal" && offsetRef.current >= COMMIT_PX) {
      gestureRef.current = null;
      suppressClickRef.current = true;
      setSettling(true);
      setCommitted(true);
      updateOffset(MAX_PX);
      actionRef.current();
      timersRef.current.push(window.setTimeout(reset, SETTLE_MS));
      return;
    }
    reset();
  }, [reset, updateOffset]);

  const onClickCapture = useCallback((event: React.MouseEvent<T>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlers = {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: reset as TouchEventHandler<T>,
    onClickCapture,
  };
  const foregroundStyle: CSSProperties = {
    transform: `translate3d(${offset}px, 0, 0)`,
    transition:
      settling ? `transform ${SETTLE_MS}ms ease-out` : offset > 0 ? "none" : undefined,
    willChange: offset > 0 ? "transform" : undefined,
  };

  return {
    offset,
    committed,
    handlers,
    foregroundStyle,
    progress: Math.min(1, offset / COMMIT_PX),
  };
}

/**
 * Standard swipe-to-Play-Next wrapper for non-table track surfaces. It keeps
 * the existing child layout intact inside a translated foreground layer.
 */
export default function MobileSwipeTrack({
  track,
  children,
  as = "div",
  className = "",
  contentClassName = "",
  surfaceClassName = "bg-surface-0",
}: {
  track: TrackDTO;
  children: React.ReactNode;
  as?: "div" | "li" | "article";
  className?: string;
  contentClassName?: string;
  surfaceClassName?: string;
}) {
  const playNext = useCallback(() => {
    usePlayerStore.getState().playNext([track]);
    useToastStore.getState().show(`Playing “${track.title}” next`);
  }, [track]);
  const swipe = useMobileSwipeAction<HTMLDivElement>(playNext);
  const Root = as;

  return (
    <Root
      className={`relative isolate overflow-hidden md:overflow-visible ${className}`}
    >
      <div
        aria-hidden
        style={{ opacity: swipe.progress }}
        className={`absolute inset-0 flex items-center gap-2 bg-accent px-4 text-sm font-semibold text-accent-fg md:hidden ${
          swipe.committed ? "justify-center" : "justify-start"
        }`}
      >
        <PlayNextIcon size={20} />
        Play next
      </div>
      <div
        {...swipe.handlers}
        style={swipe.foregroundStyle}
        className={`relative z-[1] ${surfaceClassName} ${contentClassName}`}
      >
        {children}
      </div>
    </Root>
  );
}
