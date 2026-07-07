"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";

export const DIALOG_EXIT_MS = 100; // matches the animate-*-out durations in globals.css

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const panelRef = useRef<HTMLDivElement>(null);
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
    const t = setTimeout(() => setClosing(false), DIALOG_EXIT_MS);
    return () => clearTimeout(t);
  }, [closing]);

  useBodyScrollLock(open);

  // Modal focus contract: move focus into the panel on open, restore it to the
  // trigger on close, and keep Tab cycling inside (it otherwise walks straight
  // out into the page behind the backdrop).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // offsetParent filters out display:none controls (hidden file inputs).
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open && !closing) return null;

  // z-[75]: above the mobile sheets (z-50/60) and the kebab menus (z-[70]) that
  // open dialogs (Edit details, delete confirms), below Toast (z-[80]).
  return (
    <div
      className={`${open ? "animate-fade-in" : "animate-fade-out"} fixed inset-0 z-[75] flex items-center justify-center bg-black/70 p-4`}
      onClick={open ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`${open ? "animate-pop-in" : "animate-pop-out"} max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-sm"} overflow-y-auto rounded-xl border border-border bg-surface-1 p-6 shadow-2xl outline-none`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close" className="text-fg-muted">
            <XIcon size={18} />
          </IconButton>
        </div>
        {open ? children : lastChildren}
      </div>
    </div>
  );
}
