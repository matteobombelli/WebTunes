"use client";

import { useEffect, useRef } from "react";
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
  smooth = false,
}: {
  className: string;
  serverDuration: number;
  barOnly?: boolean;
  /** Animate the visible range thumb between coarse media `timeupdate` ticks. */
  smooth?: boolean;
}) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const rangeRef = useRef<HTMLInputElement | null>(null);
  const elapsedRef = useRef<HTMLSpanElement | null>(null);
  const scrubbingRef = useRef(false);
  const smoothOriginRef = useRef({ seconds: currentTime, at: 0 });

  const totalDuration = serverDuration > 0 ? serverDuration : duration || 0;
  const playedSeconds = currentTime;

  // `timeupdate` is intentionally stored at only ~4Hz. In the immersive track
  // view, advance the range thumb from the latest real media position on each
  // animation frame so it glides between those authoritative samples. The
  // input stays uncontrolled so a pointer/keyboard scrub is never snapped back
  // by a stale React value while the seek is landing on the media element.
  useEffect(() => {
    const range = rangeRef.current;
    if (!range) return;
    const clamped = Math.min(Math.max(0, playedSeconds), totalDuration || Infinity);
    const startedAt = performance.now();
    smoothOriginRef.current = { seconds: clamped, at: startedAt };
    if (!scrubbingRef.current) range.value = String(clamped);
    if (!smooth || !isPlaying || totalDuration <= 0) return;

    let animationFrame = 0;
    let lastLabel = formatTime(clamped);
    const tick = (now: number) => {
      if (!scrubbingRef.current) {
        const origin = smoothOriginRef.current;
        const seconds = Math.min(
          totalDuration,
          origin.seconds + (now - origin.at) / 1000
        );
        range.value = String(seconds);
        const label = formatTime(seconds);
        if (label !== lastLabel && elapsedRef.current) {
          elapsedRef.current.textContent = label;
          lastLabel = label;
        }
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, playedSeconds, smooth, totalDuration]);

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
      <span ref={elapsedRef} className="w-10 shrink-0 text-right tabular-nums">
        {formatTime(playedSeconds)}
      </span>
      <input
        ref={rangeRef}
        type="range"
        min={0}
        max={totalDuration}
        step="any"
        defaultValue={Math.min(playedSeconds, totalDuration || Infinity)}
        onPointerDown={() => {
          scrubbingRef.current = true;
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
        }}
        onKeyDown={() => {
          scrubbingRef.current = true;
        }}
        onKeyUp={() => {
          scrubbingRef.current = false;
        }}
        onBlur={() => {
          scrubbingRef.current = false;
        }}
        onChange={(e) => {
          const seconds = Number(e.target.value);
          smoothOriginRef.current = { seconds, at: performance.now() };
          if (elapsedRef.current) {
            elapsedRef.current.textContent = formatTime(seconds);
          }
          usePlayerStore.getState().seekTo(seconds);
        }}
        className="h-5 min-w-0 flex-1 cursor-pointer accent-accent"
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 tabular-nums">
        {formatTime(totalDuration)}
      </span>
    </div>
  );
}
