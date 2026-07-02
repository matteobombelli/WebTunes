import { cn } from "./cn";

/** A shimmering placeholder block. Size/shape via className. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-shimmer rounded", className)} />;
}

/** The shared "art square + text bar" track-row placeholder list. */
export function TrackRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}
