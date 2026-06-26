"use client";

import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * The player's elapsed/total time readout + seek slider, isolated into its own
 * leaf component so the high-frequency currentTime ticks (the <audio> element's
 * timeupdate, throttled to ~4Hz by PlayerBar) re-render only this — not the
 * whole PlayerBar subtree. It also owns the per-tick MediaSession position
 * update for the same reason.
 *
 * `serverDuration` is the upload-measured track length. Some mobile browsers
 * misreport <audio>.duration for Ogg/Opus files (seen ~3x too long: the 48 kHz
 * granule divided by a wrong rate), intermittently — the same track can read a
 * sane duration on one load and an inflated one on the next. When the browser's
 * value disagrees materially we display serverDuration as the total. We do NOT
 * rescale currentTime: on the affected devices it already advances in real
 * seconds even when duration is inflated.
 */
export default function PlayerProgress({
  className,
  serverDuration,
}: {
  className: string;
  serverDuration: number;
}) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);

  const durationUnreliable =
    serverDuration > 0 &&
    duration > 0 &&
    Math.abs(duration - serverDuration) / serverDuration > 0.1;
  const totalDuration = durationUnreliable
    ? serverDuration
    : duration || serverDuration || 0;
  const playedSeconds = currentTime;

  // Report the reliable duration + live position to the OS Now Playing UI.
  // Without this, iOS reads the <audio> element's own (sometimes wildly
  // misreported) duration and shows ±10s skip buttons instead of the
  // previous/next-track arrows; the server-measured duration keeps it correct.
  useEffect(() => {
    if (
      !("mediaSession" in navigator) ||
      !navigator.mediaSession.setPositionState
    )
      return;
    if (!totalDuration || !Number.isFinite(totalDuration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: totalDuration,
        playbackRate: 1,
        position: Math.min(Math.max(0, playedSeconds), totalDuration),
      });
    } catch {
      // Invalid state (e.g. a transient position > duration mid-transition).
    }
  }, [totalDuration, playedSeconds]);

  return (
    <div className={`${className} items-center gap-2 text-xs text-fg-muted`}>
      <span className="w-10 shrink-0 text-right tabular-nums">
        {formatTime(playedSeconds)}
      </span>
      <input
        type="range"
        min={0}
        max={totalDuration}
        step={0.5}
        value={Math.min(playedSeconds, totalDuration || Infinity)}
        onChange={(e) =>
          usePlayerStore.getState().seekTo(Number(e.target.value))
        }
        className="h-5 min-w-0 flex-1 cursor-pointer accent-accent"
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 tabular-nums">
        {formatTime(totalDuration)}
      </span>
    </div>
  );
}
