import { Skeleton } from "@/components/ui/Skeleton";

// Shown instantly (via Suspense) while the Discover sections + friends queries
// run. Mirrors the page shell: a header row, the radio button, then a few
// sections (title bar + a row of album-art tiles).
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        {/* The heading is statically known - render it (like the other loading
            shells) instead of flashing a skeleton bar in its place. */}
        <h1 className="font-display text-4xl font-bold tracking-tight">Discover</h1>
        <Skeleton className="h-9 w-48 rounded-md" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-5">
        <Skeleton className="h-14 w-full rounded-xl" />
        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s}>
            <div className="mb-3 flex items-center gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="ml-auto h-7 w-40 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className={`aspect-square w-full rounded-lg ${
                    i >= 4 ? "hidden sm:block" : ""
                  }`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
