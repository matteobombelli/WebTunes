"use client";

import TrackArt from "@/components/TrackArt";
import { ChevronDownIcon, XIcon } from "@/components/icons";
import { useExclusionsStore } from "@/stores/exclusions";

/**
 * The Settings sub-view listing the tracks the user has excluded from their
 * Play Similar feed, each removable. Reads the global exclusions store (seeded
 * on app load); removing an entry re-includes the track in the feed.
 */
export default function ExcludedSongsList({
  onBack,
}: {
  onBack: () => void;
}) {
  const tracks = useExclusionsStore((s) => s.tracks);
  const include = useExclusionsStore((s) => s.include);

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-3 flex items-center gap-1 text-sm text-fg-muted hover:text-white"
      >
        {/* No left-chevron glyph exists; the down chevron rotated points left. */}
        <ChevronDownIcon size={14} className="rotate-90" />
        Back
      </button>
      <p className="mb-3 text-xs text-fg-muted">
        These songs won&apos;t appear in your Play Similar radio. Remove one to
        let it back in.
      </p>
      {tracks.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-subtle">
          No excluded songs.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tracks.map((track) => (
            <li
              key={track.id}
              className="flex items-center gap-2 rounded-md px-1 py-1"
            >
              <TrackArt track={track} size="h-9 w-9" iconSize={16} thumb />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{track.title}</p>
                <p className="truncate text-xs text-fg-muted">
                  {track.artist ?? "—"}
                  {track.ownerName ? ` · ${track.ownerName}` : ""}
                </p>
              </div>
              <button
                onClick={() => include(track.id)}
                aria-label={`Include ${track.title} in Play Similar`}
                title="Include in Play Similar"
                className="rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-white"
              >
                <XIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
