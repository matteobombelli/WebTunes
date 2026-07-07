"use client";

import { useEffect } from "react";

/**
 * Locks body scroll while `active` so the page can't scroll under an overlay
 * (notably on mobile), padding for the removed scrollbar width to avoid a
 * desktop reflow. Shared by Dialog and the mobile now-playing sheet.
 */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
    };
  }, [active]);
}
