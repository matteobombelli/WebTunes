"use client";

import { useEffect, useRef, useState } from "react";
import { api, fetchSimilarTracks, streamSrc } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import { usePlaySimilarRefill } from "@/components/usePlaySimilarRefill";
import QueuePanel from "@/components/QueuePanel";
import { AddToPlaylistMenu } from "@/components/TrackList";
import TrackArt from "@/components/TrackArt";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  ShuffleIcon,
  SimilarIcon,
  VolumeIcon,
} from "@/components/icons";

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Target loudness (LUFS) tracks are attenuated toward; ReplayGain reference. */
const TARGET_LUFS = -18;

export default function PlayerBar({
  initialNormalizeVolume,
  initialSimilarDrift,
}: {
  initialNormalizeVolume: boolean;
  initialSimilarDrift: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Track id we've already reported a ≥30s play for, so each load counts once.
  const countedRef = useRef<string | null>(null);
  // True from a fresh track load until playback actually begins. A cold first
  // request (slow first byte after a refresh) can let the media clock drift
  // ahead while the element stalls, so the track audibly starts a second or
  // two in. When it really starts playing we snap a drifted playhead back to 0.
  const freshLoadRef = useRef(false);
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const normalizeVolume = usePlayerStore((s) => s.normalizeVolume);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const shuffled = usePlayerStore((s) => s.shuffled);
  const playSimilar = usePlayerStore((s) => s.playSimilar);
  const [queueOpen, setQueueOpen] = useState(false);

  // Keep the "play similar" radio's queue topped up while it's active.
  usePlaySimilarRefill();

  // Toggle "play similar": off → seed from the current track and fetch the
  // first batch; on → stop refilling (leaving the queue as-is).
  const handlePlaySimilar = async () => {
    const store = usePlayerStore.getState();
    if (store.playSimilar) {
      store.stopSimilar();
      return;
    }
    if (store.index < 0) return;
    const seed = store.queue[store.index];
    // Enable optimistically so the button turns active immediately; the first
    // batch loads asynchronously and populates the queue when it lands.
    store.enableSimilar(seed.id);
    try {
      const similar = await fetchSimilarTracks(seed.id, [seed.id], 10);
      const s2 = usePlayerStore.getState();
      // Toggled off (or re-seeded) while loading — drop this stale result.
      if (!s2.playSimilar || s2.similarSeedId !== seed.id) return;
      // No embedding for the seed yet (or nothing similar) — turn back off.
      if (similar.length === 0) {
        s2.stopSimilar();
        return;
      }
      s2.startSimilar(seed.id, similar);
    } catch {
      // Revert the optimistic enable on failure (unless re-toggled meanwhile).
      const s2 = usePlayerStore.getState();
      if (s2.playSimilar && s2.similarSeedId === seed.id) s2.stopSimilar();
    }
  };
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

  // Some mobile browsers misreport <audio>.duration for Ogg/Opus files (seen
  // ~3x too long: the 48 kHz granule divided by a wrong rate). The server
  // extracts the true length on upload, so when the browser's value disagrees
  // materially, trust track.durationSec and rescale currentTime (it shares the
  // same wrong timebase) so the seek bar, labels, and seeking stay consistent.
  // When the browser is correct (desktop, well-formed reads) this is a no-op.
  const serverDuration = track?.durationSec ?? 0;
  const durationUnreliable =
    serverDuration > 0 &&
    duration > 0 &&
    Math.abs(duration - serverDuration) / serverDuration > 0.1;
  const totalDuration = durationUnreliable
    ? serverDuration
    : duration || serverDuration || 0;
  const timeScale = durationUnreliable ? serverDuration / duration : 1;
  const playedSeconds = currentTime * timeScale;

  // play() rejects with AbortError when a newer src load or a pause()
  // supersedes it (e.g. skipping tracks faster than they start) — that's
  // benign and the new action already owns the playing state, so only a real
  // failure (autoplay blocked, bad source) should flip the UI to paused.
  const onPlayError = (err: unknown) => {
    if ((err as { name?: string })?.name !== "AbortError") _setPlaying(false);
  };

  // Point the audio element at the track's stable stream URL (302s to a
  // presigned S3 URL online; served from the offline cache by the SW).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.src = streamSrc(track.id);
    freshLoadRef.current = true;
    if (usePlayerStore.getState().isPlaying) {
      audio.play().catch(onPlayError);
    }
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (isPlaying) audio.play().catch(onPlayError);
    else audio.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate the persisted "Normalize volume" setting from the server once, so
  // the player and the library toggle share one source of truth without a flash.
  useEffect(() => {
    usePlayerStore.getState().setNormalizeVolume(initialNormalizeVolume);
  }, [initialNormalizeVolume]);

  // Hydrate the persisted "play similar drift" setting once, so the refill hook
  // and the settings toggle share one source of truth.
  useEffect(() => {
    usePlayerStore.getState().setSimilarDrift(initialSimilarDrift);
  }, [initialSimilarDrift]);

  // Effective volume = master slider × per-track normalization factor. The
  // factor only ever attenuates (≤ 1): loud tracks are pulled down toward
  // TARGET_LUFS, tracks already quieter than the target are left untouched.
  // Recomputed on track change because the factor is per-track.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const lufs = track?.loudnessLufs;
    const norm =
      normalizeVolume && lufs != null
        ? Math.min(1, 10 ** ((TARGET_LUFS - lufs) / 20))
        : 1;
    audio.volume = Math.max(0, Math.min(1, volume * norm));
  }, [volume, track?.id, track?.loudnessLufs, normalizeVolume]);

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
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: totalDuration,
        position: Math.min(playedSeconds, totalDuration),
        playbackRate: 1,
      });
    } catch {
      // Invalid state mid-track-change; the next tick fixes it.
    }
  }, [playedSeconds, totalDuration]);

  if (!track) return null;

  // Times + slider, shared by both layouts (the wrapper class differs).
  const seekBar = (className: string) => (
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
        onChange={(e) => seekTo(Number(e.target.value) / timeScale)}
        className="h-1 min-w-0 flex-1 accent-accent"
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 tabular-nums">
        {formatTime(totalDuration)}
      </span>
    </div>
  );

  const art = (size: string, iconSize: number) => (
    <div className="shrink-0">
      <TrackArt track={track} size={size} iconSize={iconSize} />
    </div>
  );

  const trackInfo = (
    <>
      <p className="truncate text-sm font-medium text-fg">{track.title}</p>
      <p className="truncate text-xs text-fg-muted">
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
      title={label}
      className={`flex items-center justify-center rounded-full ${className}`}
    >
      {icon}
    </button>
  );

  return (
    <div className="relative border-t border-border-subtle bg-surface-1">
      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
      <audio
        ref={audioRef}
        onPlaying={(e) => {
          // First real playback after a load: if the clock drifted ahead while
          // the cold stream stalled (and the user didn't ask to resume/seek),
          // restart from the top so the intro isn't skipped.
          if (!freshLoadRef.current) return;
          freshLoadRef.current = false;
          if (
            usePlayerStore.getState().seekRequest === null &&
            e.currentTarget.currentTime > 0.8
          ) {
            e.currentTarget.currentTime = 0;
          }
        }}
        onTimeUpdate={(e) => {
          const ct = e.currentTarget.currentTime;
          _setProgress(ct, e.currentTarget.duration || 0);
          // Count a "friend play" once the track passes 30s (server ignores
          // the owner's own plays). Fire-and-forget; silent if offline.
          if (track && ct >= 30 && countedRef.current !== track.id) {
            countedRef.current = track.id;
            api(`/tracks/${track.id}/play`, { method: "POST" }).catch(() => {});
          }
        }}
        onEnded={next}
      />

      {/* Mobile (below md, matching MobileNav): the desktop single row has no
          room for a usable slider, so stack a full-width seek row above a
          track-info + transport row with finger-sized targets. */}
      <div className="flex flex-col gap-1 px-4 pb-2 pt-3 md:hidden">
        {seekBar("flex")}
        <div className="flex items-center gap-2">
          {art("h-10 w-10", 18)}
          <div className="min-w-0 flex-1">{trackInfo}</div>
          <div className="flex shrink-0 items-center gap-1">
            <AddToPlaylistMenu
              trackIds={[track.id]}
              floating
              dropUp
              triggerClassName="flex h-10 w-10 items-center justify-center rounded-full text-fg-muted active:bg-surface-2"
            />
            {transportButton(
              toggleShuffle,
              shuffled ? "Disable shuffle" : "Enable shuffle",
              <ShuffleIcon size={18} />,
              `h-10 w-10 active:bg-surface-2 ${
                shuffled ? "text-accent-bright" : "text-fg-muted"
              }`
            )}
            {transportButton(
              handlePlaySimilar,
              playSimilar ? "Stop play similar" : "Play similar",
              <SimilarIcon size={18} />,
              `h-10 w-10 active:bg-surface-2 ${
                playSimilar ? "text-accent-bright" : "text-fg-muted"
              }`
            )}
            {transportButton(
              prev,
              "Previous",
              <PrevIcon size={20} />,
              "h-11 w-11 text-fg-muted active:bg-surface-2"
            )}
            {transportButton(
              toggle,
              isPlaying ? "Pause" : "Play",
              isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />,
              "h-12 w-12 bg-accent text-white shadow-lg shadow-accent/40 active:bg-accent-hover"
            )}
            {transportButton(
              next,
              "Next",
              <NextIcon size={20} />,
              "h-11 w-11 text-fg-muted active:bg-surface-2"
            )}
            {transportButton(
              () => setQueueOpen((o) => !o),
              queueOpen ? "Hide queue" : "Show queue",
              <QueueIcon size={18} />,
              `h-10 w-10 active:bg-surface-2 ${
                queueOpen ? "text-accent-bright" : "text-fg-muted"
              }`
            )}
          </div>
        </div>
      </div>

      {/* Desktop (md and up): the original single row, unchanged. */}
      <div className="hidden items-center gap-3 py-3 pl-4 pr-6 md:flex">
        <div className="flex w-56 shrink-0 items-center gap-2">
          {art("h-11 w-11", 20)}
          <div className="min-w-0 flex-1">{trackInfo}</div>
        </div>

        <AddToPlaylistMenu
          trackIds={[track.id]}
          floating
          dropUp
          triggerClassName="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-white"
        />

        <div className="flex shrink-0 items-center gap-1">
          {transportButton(
            toggleShuffle,
            shuffled ? "Disable shuffle" : "Enable shuffle",
            <ShuffleIcon size={16} />,
            `h-10 w-10 hover:bg-surface-2 ${
              shuffled
                ? "text-accent-bright hover:text-accent-bright"
                : "text-fg-muted hover:text-white"
            }`
          )}
          {transportButton(
            handlePlaySimilar,
            playSimilar ? "Stop play similar" : "Play similar",
            <SimilarIcon size={16} />,
            `h-10 w-10 hover:bg-surface-2 ${
              playSimilar
                ? "text-accent-bright hover:text-accent-bright"
                : "text-fg-muted hover:text-white"
            }`
          )}
          {transportButton(
            prev,
            "Previous",
            <PrevIcon size={18} />,
            "h-10 w-10 text-fg-muted hover:bg-surface-2 hover:text-white"
          )}
          {transportButton(
            toggle,
            isPlaying ? "Pause" : "Play",
            isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />,
            "h-10 w-10 bg-accent text-white shadow-md shadow-accent/40 hover:bg-accent-hover"
          )}
          {transportButton(
            next,
            "Next",
            <NextIcon size={18} />,
            "h-10 w-10 text-fg-muted hover:bg-surface-2 hover:text-white"
          )}
        </div>

        {seekBar("flex min-w-0 flex-1")}

        {transportButton(
          () => setQueueOpen((o) => !o),
          queueOpen ? "Hide queue" : "Show queue",
          <QueueIcon size={16} />,
          `h-10 w-10 shrink-0 hover:bg-surface-2 ${
            queueOpen
              ? "text-accent-bright hover:text-accent-bright"
              : "text-fg-muted hover:text-white"
          }`
        )}

        <div className="flex w-32 shrink-0 items-center gap-2">
          <span title="Volume" className="flex shrink-0">
            <VolumeIcon size={16} className="text-fg-muted" />
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 min-w-0 flex-1 accent-accent"
            aria-label="Volume"
            title="Volume"
          />
        </div>
      </div>
    </div>
  );
}
