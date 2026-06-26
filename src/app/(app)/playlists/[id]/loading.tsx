// Shown instantly (via Suspense) while a playlist's detail + track queries run,
// so opening a playlist gives immediate feedback. Mirrors the PlaylistDetail
// header (cover + title + actions) and track list.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="h-40 w-40 shrink-0 animate-pulse rounded-md bg-surface-2" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-16 animate-pulse rounded bg-surface-2" />
          <div className="mt-2 h-8 w-2/3 animate-pulse rounded bg-surface-2" />
          <div className="mt-3 h-9 w-40 animate-pulse rounded-md bg-surface-2" />
        </div>
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
