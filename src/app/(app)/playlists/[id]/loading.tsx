import { Skeleton, TrackRowsSkeleton } from "@/components/ui/Skeleton";

// Shown instantly (via Suspense) while a playlist's detail + track queries run,
// so opening a playlist gives immediate feedback. Mirrors the PlaylistDetail
// header (cover + title + actions) and track list.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Skeleton className="h-40 w-40 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-8 w-2/3" />
          <Skeleton className="mt-3 h-9 w-40 rounded-md" />
        </div>
      </div>
      <TrackRowsSkeleton />
    </div>
  );
}
