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
        <div className="h-9 w-24 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="h-10 min-w-[16rem] flex-1 animate-pulse rounded-md bg-surface-2" />
        <div className="h-10 w-56 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="flex flex-col gap-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <div className="h-9 w-9 animate-pulse rounded bg-surface-2" />
            <div className="h-4 flex-1 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
