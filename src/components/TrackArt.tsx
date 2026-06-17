"use client";

import { useState } from "react";
import { artSrc } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { MusicIcon } from "@/components/icons";

/**
 * Cover-art thumbnail for a track. Shows the embedded art via the stable
 * /art endpoint, falling back to a music-note placeholder when the track has
 * no art or the image can't load (e.g. offline, expired redirect).
 */
export default function TrackArt({
  track,
  size,
  className = "",
  iconSize,
}: {
  track: Pick<TrackDTO, "id" | "artS3Key">;
  /** Tailwind size classes for the box, e.g. "h-9 w-9". */
  size: string;
  className?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);
  const showArt = track.artS3Key && !failed;
  const base = `${size} shrink-0 rounded bg-surface-2 ${className}`;

  if (showArt) {
    return (
      // Presigned S3 redirect; next/image cannot optimize short-lived URLs.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={artSrc(track.id)}
        alt=""
        onError={() => setFailed(true)}
        className={`${base} object-cover`}
      />
    );
  }
  return (
    <div className={`${base} flex items-center justify-center text-fg-subtle`}>
      <MusicIcon size={iconSize} />
    </div>
  );
}
