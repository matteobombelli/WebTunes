import { Skeleton, TrackRowsSkeleton } from "@/components/ui/Skeleton";

// Shown instantly (via Suspense) while a friend's profile queries run. Mirrors
// the page shell: name, their Top 100 tile row, then their library list.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <Skeleton className="mb-6 h-10 w-56" />
      <Skeleton className="mb-3 h-5 w-40" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton
            key={i}
            className={`aspect-square w-full rounded-lg ${
              i >= 4 ? "hidden sm:block" : ""
            }`}
          />
        ))}
      </div>
      <div className="mt-8">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mb-3 mt-2 h-4 w-32" />
        <TrackRowsSkeleton />
      </div>
    </div>
  );
}
