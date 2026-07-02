import { Skeleton, TrackRowsSkeleton } from "@/components/ui/Skeleton";

// Shown instantly (via Suspense) while the library page's track query runs, so
// switching to the Library tab gives immediate feedback instead of hanging on
// the previous page. Mirrors the page shell in page.tsx.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Your Library
        </h1>
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Skeleton className="h-10 min-w-[16rem] flex-1 rounded-md" />
        <Skeleton className="h-10 w-56 rounded-md" />
      </div>
      <TrackRowsSkeleton />
    </div>
  );
}
