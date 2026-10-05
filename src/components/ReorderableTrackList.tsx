"use client";

import { memo, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
import type { TrackDTO } from "@/lib/types";
import { GripIcon } from "@/components/icons";
import TrackArt from "@/components/TrackArt";

// A stripped sortable row for reorder mode (grip + art + title/artist only),
// mirroring the player queue's QueueRow. The whole table's row chrome (play,
// checkbox, kebab) is intentionally dropped here - reordering is the one job.
const ReorderRow = memo(function ReorderRow({ track }: { track: TrackDTO }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : undefined,
      }}
      className="flex items-center gap-3 border-b border-border-subtle/60 py-2 pr-1"
    >
      <TrackArt track={track} size="h-11 w-11 sm:h-9 sm:w-9" iconSize={18} thumb />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium sm:text-sm">{track.title}</p>
        <p className="truncate text-xs text-fg-muted">{track.artist ?? "-"}</p>
      </div>
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${track.title}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg active:cursor-grabbing"
      >
        <GripIcon size={18} />
      </button>
    </li>
  );
});

// The drag-and-drop list shown in reorder mode. Self-contained @dnd-kit context
// (like QueuePanel) so the normal table stays untouched; all rows are mounted
// (no windowing - playlists are small) so SortableContext can measure them.
export default function ReorderableTrackList({
  tracks,
  onMove,
}: {
  tracks: TrackDTO[];
  onMove: (activeId: string, overId: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    // A small activation distance keeps a tap distinct from a drag (and lets the
    // page still scroll from a touch that starts on the grip).
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const items = useMemo(() => tracks.map((t) => t.id), [tracks]);
  const active = activeId ? tracks.find((t) => t.id === activeId) ?? null : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={({ active, over }) => {
        setActiveId(null);
        if (over && active.id !== over.id) onMove(String(active.id), String(over.id));
      }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <ul>
          {tracks.map((t) => (
            <ReorderRow key={t.id} track={t} />
          ))}
        </ul>
      </SortableContext>
      <DragOverlay>
        {active ? (
          <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 py-2 pl-1 pr-1 shadow-lg">
            <TrackArt
              track={active}
              size="h-11 w-11 sm:h-9 sm:w-9"
              iconSize={18}
              thumb
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-medium sm:text-sm">
                {active.title}
              </p>
              <p className="truncate text-xs text-fg-muted">
                {active.artist ?? "-"}
              </p>
            </div>
            <span className="shrink-0 p-1 text-fg-subtle">
              <GripIcon size={18} />
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
