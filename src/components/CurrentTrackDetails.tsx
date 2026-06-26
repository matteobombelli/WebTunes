"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TrackDTO } from "@/lib/types";
import TrackArt from "@/components/TrackArt";

/**
 * The current track's art + title + (clickable) artist/album + owner. Shared by
 * the desktop QueuePanel header (full-width art, stacked), the mobile queue
 * header (compact `row`), and the mobile Now-Playing view (large centered art).
 * `onNavigate` fires when an artist/album link is tapped so the containing
 * overlay can close itself before the route changes.
 */
export default function CurrentTrackDetails({
  track,
  artSize,
  iconSize,
  row = false,
  align = "start",
  trailing,
  onNavigate,
}: {
  track: TrackDTO;
  artSize: string;
  iconSize: number;
  /** Compact horizontal layout (art left, details right). */
  row?: boolean;
  /** Text/cross-axis alignment for the stacked layout. */
  align?: "start" | "center";
  /** Optional action node (e.g. a kebab menu) pinned to the right of the
   *  title/artist text; forces the text to left-align even when `centered`. */
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  const centered = !row && align === "center";
  const titleClass = row ? "text-sm" : centered ? "text-lg" : "text-base";

  const text = (
    <div className="min-w-0 max-w-full">
      <p className={`truncate font-semibold text-fg ${titleClass}`}>
        {track.title}
      </p>
      <p className="truncate text-sm text-fg-muted">
        {track.artist ? (
          <Link
            href={`/artist?name=${encodeURIComponent(track.artist)}`}
            onClick={onNavigate}
            className="hover:text-accent-bright hover:underline"
          >
            {track.artist}
          </Link>
        ) : (
          "Unknown artist"
        )}
        {track.album ? (
          <>
            {" · "}
            <Link
              href={`/album?name=${encodeURIComponent(track.album)}`}
              onClick={onNavigate}
              className="hover:text-accent-bright hover:underline"
            >
              {track.album}
            </Link>
          </>
        ) : null}
      </p>
      {track.ownerName ? (
        <p className="truncate text-xs text-fg-subtle">from {track.ownerName}</p>
      ) : null}
    </div>
  );

  if (row) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <TrackArt track={track} size={artSize} iconSize={iconSize} />
        <div className="min-w-0 flex-1">{text}</div>
        {trailing}
      </div>
    );
  }

  return (
    <div
      className={`flex min-w-0 flex-col gap-3 ${
        centered ? (trailing ? "items-center" : "items-center text-center") : ""
      }`}
    >
      <TrackArt track={track} size={artSize} iconSize={iconSize} />
      {trailing ? (
        <div className="flex w-full items-center gap-2">
          <div className="min-w-0 flex-1">{text}</div>
          {trailing}
        </div>
      ) : (
        text
      )}
    </div>
  );
}
