"use client";

import { create } from "zustand";

// Imperative themed replacement for window.confirm(): callers await
// `confirmAction("Delete this track?", { confirmLabel: "Delete" })` and the
// globally-mounted <ConfirmDialog> resolves it. One pending question at a time
// (a second ask cancels the first), matching native confirm semantics.
type ConfirmState = {
  message: string | null;
  confirmLabel: string;
  resolver: ((ok: boolean) => void) | null;
  ask: (message: string, opts?: { confirmLabel?: string }) => Promise<boolean>;
  settle: (ok: boolean) => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  message: null,
  confirmLabel: "Confirm",
  resolver: null,
  ask: (message, opts) => {
    get().resolver?.(false);
    return new Promise<boolean>((resolve) => {
      set({
        message,
        confirmLabel: opts?.confirmLabel ?? "Confirm",
        resolver: resolve,
      });
    });
  },
  settle: (ok) => {
    get().resolver?.(ok);
    set({ message: null, resolver: null });
  },
}));

/** Shorthand for non-component call sites. */
export function confirmAction(
  message: string,
  opts?: { confirmLabel?: string }
): Promise<boolean> {
  return useConfirmStore.getState().ask(message, opts);
}
