"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { NotificationDot } from "./NotificationDot";

type Option<T extends string> = {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Show a red notification dot on this option. */
  dot?: boolean;
};

/**
 * Segmented control with a single accent pill that slides between options.
 * The pill is measured off the active button (offsetLeft/offsetWidth) so
 * options may have different widths; the first measurement skips the slide
 * transition so the pill doesn't animate in from the left on mount.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "default",
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /** "lg" enlarges the control on mobile (used by the Discover/Friends tab). */
  size?: "default" | "lg";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);

  const activeIndex = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const btn = container.querySelectorAll("button")[activeIndex];
      if (btn) setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    setReady(true);
    window.addEventListener("resize", measure, { passive: true });
    return () => window.removeEventListener("resize", measure);
  }, [activeIndex]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex rounded-md border border-border",
        size === "lg" ? "text-base sm:text-sm" : "text-sm",
      )}
    >
      {pill && (
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0 top-0 rounded-md bg-accent",
            ready && "transition-all duration-200 ease-out",
          )}
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-label={o.label}
          title={o.label}
          className={cn(
            "relative z-10 flex items-center gap-1.5 first:rounded-l-md last:rounded-r-md",
            size === "lg" ? "px-4 py-2.5 sm:px-3 sm:py-2" : "px-3 py-2",
            o.value === value ? "text-white" : "text-fg-muted hover:text-fg",
          )}
        >
          {o.icon}
          {/* Label hides below sm: icon-only on mobile, icon + text on desktop. */}
          <span className={cn(o.icon ? "hidden sm:inline" : undefined)}>
            {o.label}
          </span>
          {o.dot && <NotificationDot />}
        </button>
      ))}
    </div>
  );
}
