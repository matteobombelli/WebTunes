import { cardClass } from "@/components/ui/Card";

// Shown instantly (via Suspense) while the playlists page query runs. Mirrors
// the page shell in page.tsx and the PlaylistBrowser card grid.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold tracking-tight">Playlists</h1>
        <div className="h-9 w-32 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={`p-3 ${cardClass}`}>
            <div className="aspect-square w-full animate-pulse rounded-md bg-surface-2" />
            <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-surface-2" />
            <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
