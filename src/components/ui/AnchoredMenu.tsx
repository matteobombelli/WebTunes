"use client";

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const EXIT_MS = 100;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

type Align = "left" | "right";
type Position = ({ top: number } | { bottom: number }) & { left: number };

function viewportPosition(
  rect: DOMRect,
  width: number,
  height: number,
  align: Align
): Position {
  const desiredLeft = align === "left" ? rect.left : rect.right - width;
  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    window.innerWidth - width - VIEWPORT_MARGIN
  );
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, desiredLeft));
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;

  if (height + GAP > spaceBelow && height + GAP <= spaceAbove) {
    return { bottom: window.innerHeight - rect.top + GAP, left };
  }
  const top = Math.min(
    rect.bottom + GAP,
    Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)
  );
  return { top, left };
}

export function useAnchoredMenu({
  align = "right",
  estimatedWidth,
  anchored = true,
  measureKey,
  ignoreOutsideSelector,
}: {
  align?: Align;
  estimatedWidth: number;
  anchored?: boolean;
  measureKey?: unknown;
  ignoreOutsideSelector?: string;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    setOpen(false);
    setClosing(true);
    exitTimerRef.current = setTimeout(() => {
      setClosing(false);
      exitTimerRef.current = null;
    }, EXIT_MS);
  }, []);

  const show = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    setClosing(false);
    if (anchored) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPosition(viewportPosition(rect, estimatedWidth, 0, align));
    }
    setOpen(true);
  }, [align, anchored, estimatedWidth]);

  const toggle = useCallback(() => {
    if (open) close();
    else show();
  }, [close, open, show]);

  useLayoutEffect(() => {
    if (!open || !anchored || !menuRef.current || !triggerRef.current) return;
    setPosition(
      viewportPosition(
        triggerRef.current.getBoundingClientRect(),
        menuRef.current.offsetWidth,
        menuRef.current.offsetHeight,
        align
      )
    );
  }, [align, anchored, measureKey, open]);

  useEffect(() => {
    if (!open || !anchored) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        ignoreOutsideSelector &&
        target instanceof Element &&
        target.closest(ignoreOutsideSelector)
      ) {
        return;
      }
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchored, close, ignoreOutsideSelector, open]);

  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    },
    []
  );

  return {
    align,
    open,
    mounted: open || closing,
    position,
    triggerRef,
    menuRef,
    close,
    show,
    toggle,
  };
}

export function AnchoredMenu({
  align,
  open,
  mounted,
  position,
  menuRef,
  className,
  children,
  submenu = false,
}: {
  align: Align;
  open: boolean;
  mounted: boolean;
  position: Position | null;
  menuRef: RefObject<HTMLDivElement | null>;
  className: string;
  children: ReactNode;
  submenu?: boolean;
}) {
  if (!mounted || !position) return null;
  const style: CSSProperties = {
    position: "fixed",
    top: "top" in position ? position.top : undefined,
    bottom: "bottom" in position ? position.bottom : undefined,
    left: position.left,
    transformOrigin: `${align} ${"bottom" in position ? "bottom" : "top"}`,
  };

  return createPortal(
    <div
      ref={menuRef}
      data-track-actions-submenu={submenu || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      style={style}
      className={`${open ? "animate-pop-in" : "animate-pop-out"} ${className}`}
    >
      {children}
    </div>,
    document.body
  );
}
