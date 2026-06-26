// Shown instantly (via Suspense) while the friends + pending-requests queries
// run. Mirrors the page shell in page.tsx.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 font-display text-2xl font-bold tracking-tight">Friends</h1>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-md border border-border-subtle p-3"
          >
            <div className="h-10 w-10 animate-pulse rounded-full bg-surface-2" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-1/3 animate-pulse rounded bg-surface-2" />
              <div className="mt-1.5 h-3 w-1/4 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
