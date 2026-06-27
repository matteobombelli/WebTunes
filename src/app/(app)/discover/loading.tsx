// Shown instantly (via Suspense) while the Discover sections + friends queries
// run. Mirrors the page shell: a header row, the radio button, then a few
// sections (title bar + a row of album-art tiles).
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div className="h-7 w-32 animate-pulse rounded bg-surface-2" />
        <div className="h-9 w-48 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="flex flex-col gap-4 sm:gap-5">
        <div className="h-14 w-full animate-pulse rounded-xl bg-surface-2" />
        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s}>
            <div className="mb-3 flex items-center gap-3">
              <div className="h-5 w-40 animate-pulse rounded bg-surface-2" />
              <div className="ml-auto h-7 w-40 animate-pulse rounded-full bg-surface-2" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className={`aspect-square w-full animate-pulse rounded-lg bg-surface-2 ${
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
