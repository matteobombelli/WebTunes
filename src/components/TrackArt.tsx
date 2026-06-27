import { artSrc } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import CoverImage from "@/components/CoverImage";

/**
 * Cover-art thumbnail for a track. Shows the embedded art via the stable
 * /art endpoint, falling back to a music-note placeholder when the track has
 * no art or the image can't load. CoverImage retries transient failures (flaky
 * network, expired cached redirect) before showing the placeholder.
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
  return (
    <CoverImage
      src={track.artS3Key ? artSrc(track.id) : null}
      iconSize={iconSize}
      className={`${size} shrink-0 rounded bg-surface-2 ${className}`}
    />
  );
}
