import { cn } from "./cn";

/**
 * Small red notification dot — shown across the path to incoming friend requests
 * (sidebar/mobile nav, the Friends segment, the Requests tab, the Incoming
 * heading). Inline by default; pass `overlay` to absolutely-position it over an
 * icon (the icon-only mobile nav). The parent must be `relative` for `overlay`.
 */
export function NotificationDot({
  overlay = false,
  className,
}: {
  overlay?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-label="New"
      className={cn(
        "h-2 w-2 shrink-0 rounded-full bg-red-500",
        overlay && "absolute right-1 top-1",
        className
      )}
    />
  );
}
