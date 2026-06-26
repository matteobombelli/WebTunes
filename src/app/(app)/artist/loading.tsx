// Shown instantly (via Suspense) while the artist page's track query runs, so
// navigating to an artist gives immediate feedback instead of hanging on the
// previous page. Mirrors the page shell in page.tsx.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-sm text-fg-muted">Artist</p>
      <div className="mb-6 mt-1 h-8 w-64 max-w-full animate-pulse rounded bg-surface-2" />
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
