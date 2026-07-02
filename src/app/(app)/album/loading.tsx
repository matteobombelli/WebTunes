import { Skeleton, TrackRowsSkeleton } from "@/components/ui/Skeleton";

// Shown instantly (via Suspense) while the album page's track query runs, so
// navigating to an album gives immediate feedback instead of hanging on the
// previous page. Mirrors the page shell in page.tsx.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-sm text-fg-muted">Album</p>
      <Skeleton className="mb-6 mt-1 h-8 w-64 max-w-full" />
      <TrackRowsSkeleton />
    </div>
  );
}
