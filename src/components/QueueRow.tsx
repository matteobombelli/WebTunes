"use client";

import Link from "next/link";
import { memo, useCallback, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripIcon, TrashIcon, XIcon } from "@/components/icons";
import { useMobileSwipeAction } from "@/components/MobileSwipeAction";
import TrackArt from "@/components/TrackArt";
import { NowPlayingBars } from "@/components/ui/NowPlayingBars";
import { type QueueItem, usePlayerStore } from "@/stores/player";

const EXIT_SLIDE_MS = 180;
const EXIT_COLLAPSE_MS = 160;

export const QueueRow = memo(function QueueRow({
  item,
  isCurrent,
  isPlaying,
  measureRef,
}: {
  item: QueueItem;
  isCurrent: boolean;
  isPlaying: boolean;
  measureRef?: (node: HTMLLIElement | null) => void;
}) {
  const { track } = item;
  const liRef = useRef<HTMLLIElement | null>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.uid });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };
  const exitStyle: React.CSSProperties = {
    transform: "translate3d(-100%, 0, 0)",
    transition: `transform ${EXIT_SLIDE_MS}ms ease-in`,
  };

  const onPlay = useCallback(() => {
    const state = usePlayerStore.getState();
    state.playAt(state.queue.findIndex(({ uid }) => uid === item.uid));
  }, [item.uid]);
  const onRemove = useCallback(() => {
    const state = usePlayerStore.getState();
    state.removeFromQueue(state.queue.findIndex(({ uid }) => uid === item.uid));
  }, [item.uid]);

  const [exiting, setExiting] = useState(false);
  const [exitHeight, setExitHeight] = useState<number>();
  const beginExit = useCallback(() => {
    setExitHeight(liRef.current?.offsetHeight);
    setExiting(true);
    // The uid lookup makes a late timer harmless if windowing unmounts the row.
    window.setTimeout(() => {
      onRemove();
      setExiting(false);
    }, EXIT_SLIDE_MS + EXIT_COLLAPSE_MS);
  }, [onRemove]);

  const swipe = useMobileSwipeAction<HTMLDivElement>(beginExit, {
    disabled: isCurrent || exiting,
    direction: "left",
  });

  return (
    <li
      ref={(node) => {
        liRef.current = node;
        setNodeRef(node);
        if (!exiting) measureRef?.(node);
      }}
      style={exiting ? { ...style, height: exitHeight } : style}
      className={`group relative isolate overflow-hidden ${
        exiting ? "animate-queue-row-collapse" : ""
      }`}
    >
      {!isCurrent && (
        <div
          aria-hidden
          style={exiting ? { opacity: 1 } : swipe.backdropStyle}
          className="absolute inset-0 flex items-center justify-end bg-red-500/85 px-5 text-white md:hidden"
        >
          <span
            className={`inline-flex transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
              exiting || swipe.committed ? "scale-125" : ""
            }`}
          >
            <TrashIcon size={20} />
          </span>
        </div>
      )}
      <div
        {...swipe.handlers}
        style={exiting ? exitStyle : swipe.foregroundStyle}
        className={`relative z-[1] flex items-center gap-2 px-4 py-1.5 ${
          isCurrent
            ? "bg-surface-3"
            : "bg-surface-1 hover:bg-surface-3/80 md:bg-surface-2"
        }`}
      >
        <TrackArt track={track} size="h-10 w-10" iconSize={18} thumb />
        <div className="min-w-0 flex-1">
          <button
            onClick={onPlay}
            disabled={isCurrent}
            title={isCurrent ? undefined : `Play ${track.title}`}
            className={`block max-w-full truncate text-left text-sm font-medium ${
              isCurrent ? "text-accent-bright" : "text-fg"
            }`}
          >
            {track.title}
          </button>
          <p className="truncate text-xs text-fg-muted">
            {track.artist ? (
              track.isSuggested ? (
                track.artist
              ) : (
                <Link
                  href={`/artist?name=${encodeURIComponent(track.artist)}`}
                  className="hover:text-accent-bright"
                >
                  {track.artist}
                </Link>
              )
            ) : (
              "Unknown artist"
            )}
            {track.ownerName ? (
              <>
                {" · from "}
                <Link
                  href={`/discover/${track.ownerId}`}
                  className="hover:text-accent-bright"
                >
                  {track.ownerName}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {isCurrent ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright">
            <NowPlayingBars playing={isPlaying} className="h-3 w-3" />
            Playing
          </span>
        ) : (
          <button
            onClick={onRemove}
            aria-label={`Remove ${track.title} from queue`}
            title="Remove from queue"
            className="sr-only shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-red-400 md:not-sr-only md:flex md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
          >
            <XIcon size={14} />
          </button>
        )}
        <button
          {...attributes}
          {...listeners}
          data-swipe-ignore
          aria-label={`Reorder ${track.title}`}
          title="Drag to reorder"
          className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
        >
          <GripIcon size={16} />
        </button>
      </div>
    </li>
  );
});

export function QueueRowOverlay({
  item,
  isCurrent,
  isPlaying,
}: {
  item: QueueItem;
  isCurrent: boolean;
  isPlaying: boolean;
}) {
  const { track } = item;
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-3 px-4 py-1.5 shadow-lg">
      <TrackArt track={track} size="h-10 w-10" iconSize={18} thumb />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-sm font-medium ${
            isCurrent ? "text-accent-bright" : "text-fg"
          }`}
        >
          {track.title}
        </p>
        <p className="truncate text-xs text-fg-muted">
          {track.artist || "Unknown artist"}
          {track.ownerName ? ` · from ${track.ownerName}` : ""}
        </p>
      </div>
      {isCurrent && (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright">
          <NowPlayingBars playing={isPlaying} className="h-3 w-3" />
          Playing
        </span>
      )}
      <span className="shrink-0 p-1 text-fg-subtle">
        <GripIcon size={16} />
      </span>
    </div>
  );
}
