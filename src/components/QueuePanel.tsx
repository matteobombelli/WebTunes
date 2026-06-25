"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { usePlayerStore, type QueueItem } from "@/stores/player";
import { GripIcon, XIcon } from "@/components/icons";
import TrackArt from "@/components/TrackArt";
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
  const { playAt, removeFromQueue, clearUpcoming, reorder } =
    usePlayerStore.getState();
  const currentRowRef = useRef<HTMLLIElement | null>(null);

  // A small activation distance lets a plain tap on the grip still register as
  // a click (and lets touch-scrolling the list work) before a drag kicks in.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = queue.findIndex((q) => q.uid === active.id);
    const to = queue.findIndex((q) => q.uid === over.id);
    if (from !== -1 && to !== -1) reorder(from, to);
  };

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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={queue.map((q) => q.uid)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="overflow-y-auto py-1">
            {queue.map((item, i) => (
              <QueueRow
                key={item.uid}
                item={item}
                isCurrent={i === index}
                isPlaying={isPlaying}
                rowRef={i === index ? currentRowRef : undefined}
                onPlay={() => playAt(i)}
                onRemove={() => removeFromQueue(i)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function QueueRow({
  item,
  isCurrent,
  isPlaying,
  rowRef,
  onPlay,
  onRemove,
}: {
  item: QueueItem;
  isCurrent: boolean;
  isPlaying: boolean;
  rowRef?: React.MutableRefObject<HTMLLIElement | null>;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const { track } = item;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.uid });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        if (rowRef) rowRef.current = node;
      }}
      style={style}
      className={`group flex items-center gap-2 px-4 py-1.5 ${
        isDragging ? "relative z-10 bg-surface-3 shadow-lg" : ""
      } ${isCurrent ? "bg-surface-3/40" : "hover:bg-surface-3/40"}`}
    >
      <TrackArt track={track} size="h-10 w-10" iconSize={18} />
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
            <Link
              href={`/artist?name=${encodeURIComponent(track.artist)}`}
              className="hover:text-accent-bright hover:underline"
            >
              {track.artist}
            </Link>
          ) : (
            "Unknown artist"
          )}
          {track.ownerName ? ` · from ${track.ownerName}` : ""}
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
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
        >
          <XIcon size={14} />
        </button>
      )}
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${track.title}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-white active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100"
      >
        <GripIcon size={16} />
      </button>
    </li>
  );
}
