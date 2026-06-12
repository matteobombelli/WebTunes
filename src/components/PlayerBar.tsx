"use client";

import { useEffect, useRef, useState } from "react";
import { streamSrc } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import QueuePanel from "@/components/QueuePanel";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  ShuffleIcon,
  VolumeIcon,
} from "@/components/icons";

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const shuffled = usePlayerStore((s) => s.shuffled);
  const [queueOpen, setQueueOpen] = useState(false);
  const {
    toggle,
    next,
    prev,
    seekTo,
    setVolume,
    toggleShuffle,
    _setProgress,
    _setPlaying,
    _clearSeek,
  } = usePlayerStore.getState();

  // Point the audio element at the track's stable stream URL (302s to a
  // presigned S3 URL online; served from the offline cache by the SW).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.src = streamSrc(track.id);
    if (usePlayerStore.getState().isPlaying) {
      audio.play().catch(() => _setPlaying(false));
    }
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (isPlaying) audio.play().catch(() => _setPlaying(false));
    else audio.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && seekRequest !== null) {
      audio.currentTime = seekRequest;
      _clearSeek();
    }
  }, [seekRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock-screen / hardware-key controls (MediaSession API).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const { toggle, next, prev, seekTo } = usePlayerStore.getState();
    session.setActionHandler("play", () => {
      if (!usePlayerStore.getState().isPlaying) toggle();
    });
    session.setActionHandler("pause", () => {
      if (usePlayerStore.getState().isPlaying) toggle();
    });
    session.setActionHandler("previoustrack", prev);
    session.setActionHandler("nexttrack", next);
    try {
      session.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined) seekTo(details.seekTime);
      });
    } catch {
      // Older browsers don't know "seekto".
    }
    return () => {
      for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto"] as const) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Unsupported action.
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? undefined,
      album: track.album ?? undefined,
      artwork: [
        { src: `${BASE_PATH}/icon-512.png`, sizes: "512x512", type: "image/png" },
      ],
    });
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(currentTime, duration),
        playbackRate: 1,
      });
    } catch {
      // Invalid state mid-track-change; the next tick fixes it.
    }
  }, [currentTime, duration]);

  if (!track) return null;

  // Times + slider, shared by both layouts (the wrapper class differs).
  const seekBar = (className: string) => (
    <div className={`${className} items-center gap-2 text-xs text-neutral-400`}>
      <span className="w-10 shrink-0 text-right tabular-nums">
        {formatTime(currentTime)}
      </span>
      <input
        type="range"
        min={0}
        max={duration || track.durationSec || 0}
        step={0.5}
        value={Math.min(currentTime, duration || Infinity)}
        onChange={(e) => seekTo(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 accent-emerald-500"
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 tabular-nums">
        {formatTime(duration || track.durationSec || 0)}
      </span>
    </div>
  );

  const trackInfo = (
    <>
      <p className="truncate text-sm font-medium text-neutral-100">{track.title}</p>
      <p className="truncate text-xs text-neutral-400">
        {track.artist ?? "Unknown artist"}
        {track.ownerName ? ` · from ${track.ownerName}` : ""}
      </p>
    </>
  );

  const transportButton = (
    action: () => void,
    label: string,
    icon: React.ReactNode,
    className: string
  ) => (
    <button
      onClick={action}
      aria-label={label}
      className={`flex items-center justify-center rounded-full ${className}`}
    >
      {icon}
    </button>
  );

  return (
    <div className="relative border-t border-neutral-800 bg-neutral-900">
      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) =>
          _setProgress(e.currentTarget.currentTime, e.currentTarget.duration || 0)
        }
        onEnded={next}
      />

      {/* Mobile (below md, matching MobileNav): the desktop single row has no
          room for a usable slider, so stack a full-width seek row above a
          track-info + transport row with finger-sized targets. */}
      <div className="flex flex-col gap-1 px-4 pb-2 pt-3 md:hidden">
        {seekBar("flex")}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{trackInfo}</div>
          <div className="flex shrink-0 items-center gap-1">
            {transportButton(
              toggleShuffle,
              shuffled ? "Disable shuffle" : "Enable shuffle",
              <ShuffleIcon size={18} />,
              `h-10 w-10 active:bg-neutral-800 ${
                shuffled ? "text-emerald-400" : "text-neutral-400"
              }`
            )}
            {transportButton(
              prev,
              "Previous",
              <PrevIcon size={20} />,
              "h-11 w-11 text-neutral-300 active:bg-neutral-800"
            )}
            {transportButton(
              toggle,
              isPlaying ? "Pause" : "Play",
              isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />,
              "h-12 w-12 bg-emerald-600 text-white active:bg-emerald-500"
            )}
            {transportButton(
              next,
              "Next",
              <NextIcon size={20} />,
              "h-11 w-11 text-neutral-300 active:bg-neutral-800"
            )}
            {transportButton(
              () => setQueueOpen((o) => !o),
              queueOpen ? "Hide queue" : "Show queue",
              <QueueIcon size={18} />,
              `h-10 w-10 active:bg-neutral-800 ${
                queueOpen ? "text-emerald-400" : "text-neutral-400"
              }`
            )}
          </div>
        </div>
      </div>

      {/* Desktop (md and up): the original single row, unchanged. */}
      <div className="hidden items-center gap-3 py-3 pl-4 pr-6 md:flex">
        <div className="w-56 min-w-0 shrink-0">{trackInfo}</div>

        <div className="flex shrink-0 items-center gap-1">
          {transportButton(
            toggleShuffle,
            shuffled ? "Disable shuffle" : "Enable shuffle",
            <ShuffleIcon size={16} />,
            `h-10 w-10 hover:bg-neutral-800 ${
              shuffled
                ? "text-emerald-400 hover:text-emerald-300"
                : "text-neutral-400 hover:text-white"
            }`
          )}
          {transportButton(
            prev,
            "Previous",
            <PrevIcon size={18} />,
            "h-10 w-10 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          )}
          {transportButton(
            toggle,
            isPlaying ? "Pause" : "Play",
            isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />,
            "h-10 w-10 bg-emerald-600 text-white hover:bg-emerald-500"
          )}
          {transportButton(
            next,
            "Next",
            <NextIcon size={18} />,
            "h-10 w-10 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          )}
        </div>

        {seekBar("flex min-w-0 flex-1")}

        {transportButton(
          () => setQueueOpen((o) => !o),
          queueOpen ? "Hide queue" : "Show queue",
          <QueueIcon size={16} />,
          `h-10 w-10 shrink-0 hover:bg-neutral-800 ${
            queueOpen
              ? "text-emerald-400 hover:text-emerald-300"
              : "text-neutral-400 hover:text-white"
          }`
        )}

        <div className="flex w-32 shrink-0 items-center gap-2">
          <VolumeIcon size={16} className="shrink-0 text-neutral-400" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 min-w-0 flex-1 accent-emerald-500"
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  );
}
