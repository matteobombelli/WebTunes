"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/stores/player";
import { XIcon } from "@/components/icons";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";

const EXIT_MS = 100; // matches the animate-*-out durations in globals.css

/** Queue popover anchored above the player bar; PlayerBar owns open state. */
export default function QueuePanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const { playAt, removeFromQueue, clearUpcoming } = usePlayerStore.getState();
  const currentRowRef = useRef<HTMLLIElement>(null);

  // Stay mounted briefly after close so the exit animation can play.
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setClosing(true);
  }
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [closing]);

  // Start the view at the playing track, not the top of history.
  useEffect(() => {
    if (open) currentRowRef.current?.scrollIntoView({ block: "center" });
  }, [open]);

  const upcoming = queue.length - index - 1;

  if (!open && !closing) return null;

  return (
    <div className={`${open ? "animate-pop-in" : "animate-pop-out"} absolute bottom-full right-0 z-20 mb-2 mr-2 flex max-h-[60dvh] w-[26rem] max-w-[calc(100vw-1rem)] flex-col rounded-md border border-border bg-surface-2 shadow-lg md:mr-4`}>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-fg">Queue</h2>
        <span className="text-xs text-fg-muted">
          {queue.length} track{queue.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {upcoming > 0 && (
          <button
            onClick={clearUpcoming}
            className="text-xs text-fg-muted hover:text-white"
          >
            Clear upcoming
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close queue"
          className="rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-white"
        >
          <XIcon size={16} />
        </button>
      </div>

      <ul className="overflow-y-auto py-1">
        {queue.map((track, i) => {
          const isCurrent = i === index;
          return (
            // Same track can be queued twice, so the id alone isn't unique.
            <li
              key={`${track.id}-${i}`}
              ref={isCurrent ? currentRowRef : undefined}
              className={`group flex items-center gap-2 px-4 py-1.5 ${
                isCurrent ? "bg-surface-3/40" : "hover:bg-surface-3/40"
              }`}
            >
              <button
                onClick={() => playAt(i)}
                disabled={isCurrent}
                className="min-w-0 flex-1 text-left"
                title={isCurrent ? undefined : `Play ${track.title}`}
              >
                <p
                  className={`truncate text-sm font-medium ${
                    isCurrent ? "text-accent-bright" : "text-fg"
                  }`}
                >
                  {track.title}
                </p>
                <p className="truncate text-xs text-fg-muted">
                  {track.artist ?? "Unknown artist"}
                  {track.ownerName ? ` · from ${track.ownerName}` : ""}
                </p>
              </button>
              {isCurrent ? (
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright">
                  <NowPlayingBars playing={isPlaying} className="h-3 w-3" />
                  Playing
                </span>
              ) : (
                <button
                  onClick={() => removeFromQueue(i)}
                  aria-label={`Remove ${track.title} from queue`}
                  title="Remove from queue"
                  className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
                >
                  <XIcon size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
