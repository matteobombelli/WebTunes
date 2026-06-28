"use client";

import { create } from "zustand";

// Minimal transient toast: one short message at a time, auto-clears. Used for
// lightweight confirmations like "Copied link to clipboard!".
type ToastState = {
  message: string | null;
  show: (message: string) => void;
};

const TOAST_MS = 2200;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  show: (message) => {
    set({ message });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ message: null }), TOAST_MS);
  },
}));
