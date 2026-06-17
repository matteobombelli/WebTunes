"use client";

import { useEffect, useState } from "react";
import { XIcon } from "@/components/icons";

const EXIT_MS = 100; // matches the animate-*-out durations in globals.css

export default function Dialog({
  title,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  // Stay mounted briefly after close so the exit animation can play.
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  // Snapshot of the last open-state children: parents often null their
  // content state on close, which would blank the panel mid-animation.
  // (Render-phase state adjustment per react.dev "storing information
  // from previous renders".)
  const [lastChildren, setLastChildren] = useState<React.ReactNode>(null);
  if (open && children !== lastChildren) setLastChildren(children);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setClosing(true);
  }

  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [closing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open && !closing) return null;

  return (
    <div
      className={`${open ? "animate-fade-in" : "animate-fade-out"} fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4`}
      onClick={open ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`${open ? "animate-pop-in" : "animate-pop-out"} max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-sm"} overflow-y-auto rounded-xl border border-border bg-surface-1 p-6 shadow-2xl`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-white"
          >
            <XIcon size={18} />
          </button>
        </div>
        {open ? children : lastChildren}
      </div>
    </div>
  );
}
