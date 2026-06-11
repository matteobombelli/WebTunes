"use client";

import { useMemo, useState } from "react";
import type { TrackDTO } from "@/lib/types";
import TrackList from "@/components/TrackList";

const SORTS = [
  { value: "added", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
] as const;

type SortKey = (typeof SORTS)[number]["value"];

export default function LibraryView({ tracks }: { tracks: TrackDTO[] }) {
  const [sort, setSort] = useState<SortKey>("added");

  const sorted = useMemo(() => {
    const copy = [...tracks];
    const byText = (get: (t: TrackDTO) => string | null) => (a: TrackDTO, b: TrackDTO) =>
      (get(a) ?? "￿").localeCompare(get(b) ?? "￿", undefined, {
        sensitivity: "base",
      });
    switch (sort) {
      case "title":
        return copy.sort(byText((t) => t.title));
      case "artist":
        return copy.sort(byText((t) => t.artist));
      case "album":
        return copy.sort(byText((t) => t.album));
      default:
        return copy; // server order: newest first
    }
  }, [tracks, sort]);

  return (
    <>
      <div className="mb-3 flex justify-end">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          Sort by
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-emerald-500"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TrackList tracks={sorted} canDelete canEdit selectable />
    </>
  );
}
