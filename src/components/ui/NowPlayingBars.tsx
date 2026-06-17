import { cn } from "./cn";

// Per-bar timing so the equaliser looks organic rather than synchronised.
const BARS = [
  { dur: "0.9s", delay: "-0.2s" },
  { dur: "1.1s", delay: "-0.5s" },
  { dur: "0.8s", delay: "-0.1s" },
  { dur: "1.0s", delay: "-0.7s" },
];

/** Animated equaliser shown for the currently-playing track. Bars freeze when
 *  `playing` is false. Colour inherits from `text-*` (defaults to accent). */
export function NowPlayingBars({
  playing = true,
  className,
}: {
  playing?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-3.5 w-3.5 items-end justify-center gap-[2px]", className)}
    >
      {BARS.map((b, i) => (
        <span
          key={i}
          className="w-[2px] flex-1 rounded-full bg-current"
          style={{
            transformOrigin: "bottom",
            transform: playing ? undefined : "scaleY(0.35)",
            animation: playing
              ? `eq-bounce ${b.dur} ease-in-out ${b.delay} infinite`
              : undefined,
          }}
        />
      ))}
    </span>
  );
}
