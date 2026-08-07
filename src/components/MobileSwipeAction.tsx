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

const START_PX = 7;
const COMMIT_PX = 72;
const MAX_PX = 112;
const SETTLE_MS = 120;
// A committed swipe snaps out (SETTLE_MS), pauses just past the end of that
// snap - long enough to read as a confirmation, short enough not to feel like a
// hang - then glides back on a long decelerating curve.
const CONFIRM_HOLD_MS = 160;
const CONFIRM_RETURN_MS = 320;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

type SwipeOptions = {
  disabled?: boolean;
  direction?: "left" | "right";
  /** CSS selector for controls that keep ownership of their touch gesture. */
  ignoreSelector?: string;
};

/**
 * Direction-locked, touch-only horizontal gesture. Vertical intent is handed
 * back to native scrolling; a completed swipe suppresses the synthetic click
 * browsers otherwise dispatch after touchend.
 */
export function useMobileSwipeAction<T extends HTMLElement>(
  onAction: () => void,
  {
    disabled = false,
    direction = "right",
    ignoreSelector = "[data-swipe-ignore]",
  }: SwipeOptions = {}
) {
  const actionRef = useRef(onAction);
  useEffect(() => {
    actionRef.current = onAction;
  }, [onAction]);
  const [offset, setOffset] = useState(0);
  // Duration of the in-flight settle transition; null while the foreground is
  // following the finger (or at rest).
  const [settleMs, setSettleMs] = useState<number | null>(null);
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

  const reset = useCallback(
    (duration: number = SETTLE_MS) => {
      gestureRef.current = null;
      setSettleMs(duration);
      setCommitted(false);
      updateOffset(0);
      timersRef.current.push(
        window.setTimeout(() => {
          setSettleMs(null);
          suppressClickRef.current = false;
        }, duration)
      );
    },
    [updateOffset]
  );

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
      // Preserve iOS's horizontal navigation gestures at the physical edges.
      if (
        (direction === "right" && touch.clientX < 18) ||
        (direction === "left" && touch.clientX > window.innerWidth - 18)
      ) {
        gestureRef.current = null;
        return;
      }
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        axis: "pending",
      };
      suppressClickRef.current = false;
      setSettleMs(null);
      setCommitted(false);
      updateOffset(0);
    },
    [clearTimers, direction, disabled, ignoreSelector, updateOffset]
  );

  const onTouchMove: TouchEventHandler<T> = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      const sign = direction === "right" ? 1 : -1;
      const travel = dx * sign;

      if (gesture.axis === "pending") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < START_PX) return;
        // Opposite-direction motion stays available to surrounding horizontal
        // surfaces; vertical motion belongs to native page/list scrolling.
        if (travel <= 0 || Math.abs(dy) >= Math.abs(dx)) {
          gesture.axis = "cancelled";
          return;
        }
        gesture.axis = "horizontal";
      }
      if (gesture.axis !== "horizontal") return;

      if (event.cancelable) event.preventDefault();
      suppressClickRef.current = true;
      const resisted =
        travel <= COMMIT_PX
          ? travel
          : COMMIT_PX + (travel - COMMIT_PX) * 0.28;
      updateOffset(sign * Math.max(0, Math.min(MAX_PX, resisted)));
    },
    [direction, updateOffset]
  );

  const onTouchEnd: TouchEventHandler<T> = useCallback(() => {
    const gesture = gestureRef.current;
    if (
      gesture?.axis === "horizontal" &&
      Math.abs(offsetRef.current) >= COMMIT_PX
    ) {
      gestureRef.current = null;
      suppressClickRef.current = true;
      setSettleMs(SETTLE_MS);
      setCommitted(true);
      updateOffset(direction === "right" ? MAX_PX : -MAX_PX);
      actionRef.current();
      timersRef.current.push(
        window.setTimeout(() => reset(CONFIRM_RETURN_MS), CONFIRM_HOLD_MS)
      );
      return;
    }
    reset();
  }, [direction, reset, updateOffset]);

  const onClickCapture = useCallback((event: React.MouseEvent<T>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlers = {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    // Not `reset` directly: it takes a duration, and the event would land there.
    onTouchCancel: (() => reset()) as TouchEventHandler<T>,
    onClickCapture,
  };
  const foregroundStyle: CSSProperties = {
    transform: `translate3d(${offset}px, 0, 0)`,
    transition:
      settleMs !== null
        ? `transform ${settleMs}ms ${EASE}`
        : offset !== 0
          ? "none"
          : undefined,
    willChange: offset !== 0 ? "transform" : undefined,
  };
  // The backdrop's opacity is React-driven, so it would otherwise cut out in a
  // single render while the foreground is still gliding back.
  // `width` rides along for backdrops sized from the offset rather than laid
  // out to fill their row.
  const backdropStyle: CSSProperties = {
    opacity: Math.min(1, Math.abs(offset) / COMMIT_PX),
    transition:
      settleMs !== null
        ? `opacity ${settleMs}ms ease-out, width ${settleMs}ms ${EASE}`
        : undefined,
  };

  return {
    offset,
    committed,
    handlers,
    foregroundStyle,
    backdropStyle,
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
  }, [track]);
  const swipe = useMobileSwipeAction<HTMLDivElement>(playNext);
  const Root = as;

  return (
    <Root
      className={`relative isolate overflow-hidden md:overflow-visible ${className}`}
    >
      <div
        aria-hidden
        style={swipe.backdropStyle}
        className="absolute inset-0 flex items-center justify-start bg-emerald-500 px-5 text-white md:hidden"
      >
        <span
          className={`inline-flex transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
            swipe.committed ? "scale-125" : ""
          }`}
        >
          <PlayNextIcon size={22} />
        </span>
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
