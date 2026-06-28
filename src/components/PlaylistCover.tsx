import { artSrc, playlistCoverSrc } from "@/lib/api";
import CoverImage from "@/components/CoverImage";

/**
 * A playlist's cover box. With an uploaded cover it renders that single image
 * (today's behavior). With no cover it falls back to a 2x2 mosaic of up to 4
 * art-bearing tracks (in playlist order); empty quadrants show the music-note
 * placeholder. With no art-bearing tracks at all it's the single placeholder.
 *
 * `className` carries the full box classes (aspect/size/rounding/bg) and is
 * applied to whichever variant renders, so callers control the shape in one
 * place — exactly like CoverImage.
 */
export default function PlaylistCover({
  playlistId,
  coverS3Key,
  artTrackIds,
  className = "",
  iconSize,
}: {
  playlistId: string;
  coverS3Key: string | null;
  /** Up to 4 art-bearing track ids, in position order. */
  artTrackIds?: string[];
  className?: string;
  iconSize?: number;
}) {
  if (coverS3Key) {
    return (
      <CoverImage
        src={playlistCoverSrc(playlistId)}
        iconSize={iconSize}
        className={className}
      />
    );
  }

  const ids = artTrackIds ?? [];
  if (ids.length === 0) {
    return <CoverImage src={null} iconSize={iconSize} className={className} />;
  }

  const cellIconSize = iconSize ? Math.round(iconSize / 2) : undefined;
  return (
    <div className={`grid grid-cols-2 grid-rows-2 overflow-hidden ${className}`}>
      {[0, 1, 2, 3].map((i) => (
        <CoverImage
          key={i}
          src={ids[i] ? artSrc(ids[i]) : null}
          iconSize={cellIconSize}
          className="h-full w-full bg-surface-2"
        />
      ))}
    </div>
  );
}
