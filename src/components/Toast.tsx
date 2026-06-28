"use client";

import { useToastStore } from "@/stores/toast";

// Single floating confirmation pill, centered above the player bar. Rendered
// once in the app layout; content comes from useToastStore.
export default function Toast() {
  const message = useToastStore((s) => s.message);
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-pop-in fixed bottom-28 left-1/2 z-[80] -translate-x-1/2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm text-fg shadow-lg md:bottom-24"
    >
      {message}
    </div>
  );
}
