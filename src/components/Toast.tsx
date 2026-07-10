"use client";

import { useEffect, useState } from "react";
import { DIALOG_EXIT_MS } from "@/components/Dialog";
import { useToastStore } from "@/stores/toast";

// Single floating confirmation pill, centered above the player bar. Rendered
// once in the app layout; content comes from useToastStore.
export default function Toast() {
  const message = useToastStore((s) => s.message);
  // Stay mounted briefly after the message clears so the exit animation can
  // play, keeping the last message so the pill doesn't blank mid-animation
  // (mirrors Dialog's closing pattern).
  const [closing, setClosing] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  if (message && message !== lastMessage) setLastMessage(message);
  const [prevMessage, setPrevMessage] = useState(message);
  if (message !== prevMessage) {
    setPrevMessage(message);
    if (!message) setClosing(true);
  }

  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), DIALOG_EXIT_MS);
    return () => clearTimeout(t);
  }, [closing]);

  if (!message && !closing) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${message ? "animate-pop-in" : "animate-pop-out"} fixed bottom-28 left-1/2 z-[80] -translate-x-1/2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm text-fg shadow-lg md:bottom-24`}
    >
      {message ?? lastMessage}
    </div>
  );
}
