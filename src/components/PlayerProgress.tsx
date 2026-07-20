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
 * timeupdate, throttled to ~4Hz by PlayerBar) re-render only this - not the
 * whole PlayerBar subtree. It also owns the per-tick MediaSession position
 * update for the same reason.
 *
 * `serverDuration` is the track length measured on upload (ffprobe on the exact
 * stored bytes), so it's authoritative and matches what the track list shows.
 * We use it as the displayed total whenever present, falling back to the <audio>
 * element's own duration only for tracks with no stored value. Browsers misreport
 * element.duration on some files (Ogg/Opus seen ~3x too long; estimated VBR-MP3
 * lengths), which made the player's total disagree with the listed time - so the
 * stored value wins. We do NOT rescale currentTime: it already advances in real
 * seconds, so the fill (currentTime/total) and seeking stay correct.
 */
export default function PlayerProgress({
  className,
  serverDuration,
  barOnly = false,
}: {
  className: string;
  serverDuration: number;
  barOnly?: boolean;
}) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);

  const totalDuration = serverDuration > 0 ? serverDuration : duration || 0;
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

  if (barOnly) {
    const pct =
      totalDuration > 0
        ? Math.min(100, (playedSeconds / totalDuration) * 100)
        : 0;
    return (
      <div
        className={`${className} h-1 overflow-hidden rounded-full bg-surface-2`}
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }

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
