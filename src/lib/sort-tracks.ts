import type { TrackDTO } from "@/lib/types";

export type SortKey =
  | "title"
  | "artist"
  | "album"
  | "owner"
  | "duration"
  | "plays";
export type SortState = { key: SortKey; dir: 1 | -1 } | null;

// U+FFFF sentinel sorts null fields after real values (ascending).
const NULL_SENTINEL = "￿";

// "owner" maps to ownerName (own tracks show as "You"), not a direct field.
function sortText(
  t: TrackDTO,
  key: "title" | "artist" | "album" | "owner"
): string {
  if (key === "owner") return t.ownerName ?? "You";
  return t[key] ?? NULL_SENTINEL;
}

export function sortTracks(tracks: TrackDTO[], sort: SortState): TrackDTO[] {
  if (!sort) return tracks;
  const copy = [...tracks];
  copy.sort((a, b) => {
    if (sort.key === "duration") {
      return ((a.durationSec ?? -1) - (b.durationSec ?? -1)) * sort.dir;
    }
    if (sort.key === "plays") {
      return (a.friendPlayCount - b.friendPlayCount) * sort.dir;
    }
    return (
      sortText(a, sort.key).localeCompare(sortText(b, sort.key), undefined, {
        sensitivity: "base",
      }) * sort.dir
    );
  });
  return copy;
}
