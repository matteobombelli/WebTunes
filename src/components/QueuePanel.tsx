"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/stores/player";
import { XIcon } from "@/components/icons";

/** Queue popover anchored above the player bar; PlayerBar owns open state. */
export default function QueuePanel({ onClose }: { onClose: () => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const { playAt, removeFromQueue, clearUpcoming } = usePlayerStore.getState();
  const currentRowRef = useRef<HTMLLIElement>(null);

  // Start the view at the playing track, not the top of history.
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: "center" });
  }, []);

  const upcoming = queue.length - index - 1;

  return (
    <div className="absolute bottom-full right-0 z-20 mb-2 mr-2 flex max-h-[60dvh] w-[26rem] max-w-[calc(100vw-1rem)] animate-pop-in flex-col rounded-md border border-neutral-700 bg-neutral-800 shadow-lg md:mr-4">
      <div className="flex items-center gap-3 border-b border-neutral-700 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-neutral-100">Queue</h2>
        <span className="text-xs text-neutral-400">
          {queue.length} track{queue.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {upcoming > 0 && (
          <button
            onClick={clearUpcoming}
            className="text-xs text-neutral-400 hover:text-white"
          >
            Clear upcoming
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close queue"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white"
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
                isCurrent ? "bg-neutral-700/40" : "hover:bg-neutral-700/40"
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
                    isCurrent ? "text-emerald-400" : "text-neutral-200"
                  }`}
                >
                  {track.title}
                </p>
                <p className="truncate text-xs text-neutral-400">
                  {track.artist ?? "Unknown artist"}
                  {track.ownerName ? ` · from ${track.ownerName}` : ""}
                </p>
              </button>
              {isCurrent ? (
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                  Playing
                </span>
              ) : (
                <button
                  onClick={() => removeFromQueue(i)}
                  aria-label={`Remove ${track.title} from queue`}
                  title="Remove from queue"
                  className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-600 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
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
