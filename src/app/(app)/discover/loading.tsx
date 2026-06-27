// Shown instantly (via Suspense) while the Discover sections + friends queries
// run. Mirrors the page shell: a header row plus a few section blocks (title
// bar + a couple of placeholder rows).
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div className="h-7 w-32 animate-pulse rounded bg-surface-2" />
        <div className="h-9 w-48 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-5">
        {Array.from({ length: 3 }).map((_, s) => (
          <div
            key={s}
            className="rounded-xl border border-border-subtle bg-surface-1 p-4 sm:p-5"
          >
            <div className="mb-3 flex items-center gap-3">
              <div className="h-5 w-40 animate-pulse rounded bg-surface-2" />
              <div className="ml-auto h-7 w-40 animate-pulse rounded-full bg-surface-2" />
            </div>
            <div className="flex flex-col gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2">
                  <div className="h-10 w-10 animate-pulse rounded bg-surface-2" />
                  <div className="min-w-0 flex-1">
                    <div className="h-4 w-1/3 animate-pulse rounded bg-surface-2" />
                    <div className="mt-1.5 h-3 w-1/4 animate-pulse rounded bg-surface-2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
