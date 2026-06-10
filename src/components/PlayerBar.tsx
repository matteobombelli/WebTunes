"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";

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
  const { toggle, next, prev, seekTo, setVolume, _setProgress, _setPlaying, _clearSeek } =
    usePlayerStore.getState();

  // Load a fresh presigned URL whenever the track changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    let cancelled = false;
    api<{ url: string }>(`/tracks/${track.id}/stream-url`)
      .then(({ url }) => {
        if (cancelled) return;
        audio.src = url;
        if (usePlayerStore.getState().isPlaying) {
          audio.play().catch(() => _setPlaying(false));
        }
      })
      .catch(() => _setPlaying(false));
    return () => {
      cancelled = true;
    };
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

  if (!track) return null;

  return (
    <div className="flex items-center gap-4 border-t border-neutral-800 bg-neutral-900 px-4 py-3">
      <audio
        ref={audioRef}
        onTimeUpdate={(e) =>
          _setProgress(e.currentTarget.currentTime, e.currentTarget.duration || 0)
        }
        onEnded={next}
        onPlay={() => _setPlaying(true)}
        onPause={() => {
          // Ignore the pause fired by track-change/src swap while playing.
          if (audioRef.current?.ended) return;
          if (!audioRef.current?.seeking && audioRef.current?.paused) {
            _setPlaying(usePlayerStore.getState().isPlaying && false);
          }
        }}
      />

      <div className="w-56 min-w-0">
        <p className="truncate text-sm font-medium text-neutral-100">{track.title}</p>
        <p className="truncate text-xs text-neutral-400">
          {track.artist ?? "Unknown artist"}
          {track.ownerName ? ` · from ${track.ownerName}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={prev}
          aria-label="Previous"
          className="rounded-full p-2 text-neutral-300 hover:bg-neutral-800 hover:text-white"
        >
          ⏮
        </button>
        <button
          onClick={toggle}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="rounded-full bg-emerald-600 p-2 px-3 text-white hover:bg-emerald-500"
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          onClick={next}
          aria-label="Next"
          className="rounded-full p-2 text-neutral-300 hover:bg-neutral-800 hover:text-white"
        >
          ⏭
        </button>
      </div>

      <div className="flex flex-1 items-center gap-2 text-xs text-neutral-400">
        <span className="w-10 text-right tabular-nums">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || track.durationSec || 0}
          step={0.5}
          value={Math.min(currentTime, duration || Infinity)}
          onChange={(e) => seekTo(Number(e.target.value))}
          className="h-1 flex-1 accent-emerald-500"
          aria-label="Seek"
        />
        <span className="w-10 tabular-nums">
          {formatTime(duration || track.durationSec || 0)}
        </span>
      </div>

      <div className="flex w-32 items-center gap-2">
        <span className="text-xs text-neutral-400">🔊</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="h-1 flex-1 accent-emerald-500"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
