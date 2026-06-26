"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, artSrc, fetchSimilarTracks, streamSrc } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import { PREFETCH_AHEAD, prefetchUpcoming } from "@/lib/offline/prefetch";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import { usePlaySimilarRefill } from "@/components/usePlaySimilarRefill";
import PlayerProgress from "@/components/PlayerProgress";
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

/** Target loudness (LUFS) tracks are attenuated toward; ReplayGain reference. */
const TARGET_LUFS = -18;

/** localStorage key for the persisted master volume (client-only preference). */
const VOLUME_KEY = "wt-volume";

/** Bounded retry/reload budget per track load, for background play() recovery. */
const MAX_ATTEMPTS = 4;

/**
 * Gated, removable audio instrumentation. Off by default; enable on-device with
 * localStorage.setItem("wt-audio-debug","1") then reload, and read the rolling
 * window.__wtAudioLog in Safari Web Inspector. iOS audio failures are otherwise
 * silent, so this makes the before/after of a track transition observable.
 */
function logAudio(event: string, detail?: string) {
  if (typeof window === "undefined") return;
  if (localStorage.getItem("wt-audio-debug") !== "1") return;
  const line = `[wt-audio] ${event}${detail ? " " + detail : ""}`;
  console.info(line);
  const w = window as unknown as { __wtAudioLog?: string[] };
  (w.__wtAudioLog ??= []).push(
    `${new Date().toISOString().slice(11, 23)} ${line}`
  );
  if (w.__wtAudioLog.length > 200) w.__wtAudioLog.shift();
}

/**
 * Always-mounted, render-nothing helper that warms the browser image cache for
 * the queue art the user is about to see (head, tail, and around the current
 * track) so thumbnails are instant when the queue panel opens. Its own narrow
 * store subscription keeps queue churn from re-rendering the PlayerBar.
 */
const QueueArtPreloader = memo(function QueueArtPreloader() {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  useEffect(() => {
    const picks = [
      ...queue.slice(0, 10),
      ...queue.slice(-10),
      ...queue.slice(Math.max(0, index - 3), index + 4),
    ];
    const seen = new Set<string>();
    for (const { track } of picks) {
      if (!track.artS3Key || seen.has(track.id)) continue;
      seen.add(track.id);
      const img = new Image();
      img.src = artSrc(track.id);
    }
  }, [queue, index]);
  return null;
});

/**
 * Render-nothing helper that pre-caches the next few tracks' audio while the
 * current one plays. iOS throttles live network for a backgrounded PWA, so a
 * streamed next track can't load when one ends in the background and sits
 * silently stuck; warming several ahead here (in the foreground) lets the
 * service worker serve consecutive background auto-advances from cache. Its own
 * narrow subscription keeps this off the PlayerBar's render path.
 */
const NextTrackPrefetcher = memo(function NextTrackPrefetcher() {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  useEffect(() => {
    if (index < 0) return;
    const nextIds = queue
      .slice(index + 1, index + 1 + PREFETCH_AHEAD)
      .map((q) => q.track.id);
    prefetchUpcoming(queue[index]?.track.id, nextIds);
  }, [queue, index]);
  return null;
});

export default function PlayerBar({
  initialNormalizeVolume,
  initialSimilarDrift,
  initialHideFriendDuplicates,
}: {
  initialNormalizeVolume: boolean;
  initialSimilarDrift: boolean;
  initialHideFriendDuplicates: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Track id we've already reported a ≥30s play for, so each load counts once.
  const countedRef = useRef<string | null>(null);
  // True from a fresh track load until playback actually begins. A cold first
  // request (slow first byte after a refresh) can let the media clock drift
  // ahead while the element stalls, so the track audibly starts a second or
  // two in. When it really starts playing we snap a drifted playhead back to 0.
  const freshLoadRef = useRef(false);
  // Gates the volume-persist effect until the saved value has been read on
  // mount, so the default (1) isn't written over the saved value first.
  const volumeHydratedRef = useRef(false);
  // A continuous, inaudible Web Audio tone kept running while a track plays so
  // the output device (notably Bluetooth) doesn't sleep during the gap between
  // tracks. When it sleeps, resuming for the next track flushes the previous
  // track's ~178 ms still in the Bluetooth buffer as an audible glitch; wired
  // output has a tiny buffer and never sleeps. See ensureOutputAwake.
  const keepAliveRef = useRef<AudioContext | null>(null);
  // True while the *next* load is an automatic advance (track-end or hard-error
  // skip) rather than a user action, so a background play() rejection on an
  // auto-advance can hold the session and retry instead of tearing it down.
  const autoAdvanceRef = useRef(false);
  // We owe a play() that a background autoplay policy blocked; retry triggers
  // (canplay/stalled/visibility) re-attempt it while the session stays held.
  const pendingPlayRef = useRef(false);
  // Bounded recovery budget per track load (reset on load and on foreground).
  const recoverAttemptsRef = useRef(0);
  // Last currentTime pushed to the store, so onTimeUpdate can throttle the
  // 4-30 Hz timeupdate down to ~4 Hz of store writes (see onTimeUpdate).
  const lastProgressRef = useRef(0);
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const normalizeVolume = usePlayerStore((s) => s.normalizeVolume);
  // NOTE: currentTime/duration are deliberately NOT subscribed here — they tick
  // 4-30 Hz and would re-render this whole bar. The time readout + seek slider
  // live in <PlayerProgress>, which subscribes to them in isolation.
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const shuffled = usePlayerStore((s) => s.shuffled);
  const playSimilar = usePlayerStore((s) => s.playSimilar);
  const [queueOpen, setQueueOpen] = useState(false);
  // Stable identity so transport-state changes don't re-render the memoized
  // QueuePanel through a fresh onClose each render.
  const closeQueue = useCallback(() => setQueueOpen(false), [setQueueOpen]);

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
    const seed = store.queue[store.index].track;
    try {
      const similar = await fetchSimilarTracks(seed.id, [seed.id], 10);
      // No embedding for the seed yet (or nothing similar) — stay off.
      if (similar.length === 0) return;
      usePlayerStore.getState().startSimilar(seed.id, similar);
    } catch {
      // Leave the mode off on failure.
    }
  };
  const {
    toggle,
    next,
    prev,
    setVolume,
    toggleShuffle,
    _setProgress,
    _setPlaying,
    _clearSeek,
  } = usePlayerStore.getState();


  // play() rejects with AbortError when a newer src load or a pause() supersedes
  // it (e.g. skipping faster than tracks start) — benign, ignore. On an automatic
  // advance (track end) iOS rejects the play() of a freshly-loaded source in the
  // background with NotAllowedError; the old code flipped isPlaying to false here,
  // which paused the element and suspended the keep-alive context — tearing down
  // the audio session and detaching the lock-screen controls. Instead, on an
  // auto-advance, hold the session and mark the play() as owed so a retry trigger
  // can resume it. Only a genuine user-initiated failure flips the UI to paused.
  const onPlayError = (err: unknown, autoAdvance: boolean) => {
    const name = (err as { name?: string })?.name;
    logAudio("play-reject", name);
    if (name === "AbortError") return;
    if (autoAdvance) {
      pendingPlayRef.current = true;
      return;
    }
    _setPlaying(false);
  };

  // Keep the audio output device awake across the gap between tracks so a
  // Bluetooth A2DP link doesn't sleep and replay the previous track's buffered
  // tail as a glitch on resume (see keepAliveRef). Created lazily and resumed
  // within the play gesture (an AudioContext starts suspended until then); the
  // tone is inaudible and only holds the output stream open.
  const ensureOutputAwake = () => {
    if (typeof window === "undefined") return;
    let ctx = keepAliveRef.current;
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001; // ~-80 dB at 40 Hz: inaudible, non-zero keeps the stream active
      osc.frequency.value = 40;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      keepAliveRef.current = ctx;
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };

  // Start (or resume) playback, routing rejections through onPlayError with the
  // auto-advance context so a background transition holds the session and retries
  // rather than tearing down. Resolves clear any owed retry.
  const attemptPlay = (autoAdvance: boolean) => {
    const audio = audioRef.current;
    if (!audio) return;
    ensureOutputAwake();
    audio
      .play()
      .then(() => {
        pendingPlayRef.current = false;
      })
      .catch((err) => onPlayError(err, autoAdvance));
  };

  // Re-attempt an owed (background-blocked) play(), bounded per track load. A
  // no-op unless a transition play() was actually rejected, so the media-event
  // triggers that call it are inert on a normal successful advance.
  const retryPendingPlay = () => {
    if (!pendingPlayRef.current) return;
    if (recoverAttemptsRef.current >= MAX_ATTEMPTS) return;
    recoverAttemptsRef.current += 1;
    logAudio("play-retry", String(recoverAttemptsRef.current));
    attemptPlay(true);
  };

  // Media-element error recovery. A hard error (bad codec/source, incl. an
  // expired presigned URL) skips on; a transient network error gets a bounded
  // same-src reload (canplay then retries play), then skips once the budget's up.
  const onAudioError = () => {
    const audio = audioRef.current;
    const mediaErr = audio?.error;
    logAudio("error", mediaErr ? `code=${mediaErr.code}` : "");
    if (!usePlayerStore.getState().isPlaying) return;
    const hard =
      mediaErr &&
      (mediaErr.code === mediaErr.MEDIA_ERR_DECODE ||
        mediaErr.code === mediaErr.MEDIA_ERR_SRC_NOT_SUPPORTED);
    if (hard || recoverAttemptsRef.current >= MAX_ATTEMPTS) {
      autoAdvanceRef.current = true; // the skip is itself an automatic advance
      next();
      return;
    }
    recoverAttemptsRef.current += 1;
    pendingPlayRef.current = true;
    audio?.load(); // fresh load of the current src; onCanPlay retries play()
  };

  // Point the audio element at the track's stable stream URL (302s to a
  // presigned S3 URL online; served from the offline cache by the SW).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.src = streamSrc(track.id);
    freshLoadRef.current = true;
    pendingPlayRef.current = false; // a new track supersedes any owed retry
    recoverAttemptsRef.current = 0; // fresh recovery budget per track
    const autoAdvance = autoAdvanceRef.current;
    autoAdvanceRef.current = false; // consume the flag
    if (usePlayerStore.getState().isPlaying) attemptPlay(autoAdvance);
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (isPlaying) {
      attemptPlay(false);
    } else {
      // A genuine stop (user pause or end-of-queue) neutralizes any stale
      // auto-advance arm and releases the keep-alive session.
      autoAdvanceRef.current = false;
      audio.pause();
      keepAliveRef.current?.suspend().catch(() => {});
    }
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release the keep-alive context when the player unmounts.
  useEffect(() => {
    return () => {
      keepAliveRef.current?.close().catch(() => {});
      keepAliveRef.current = null;
    };
  }, []);

  // Back in the foreground, play() is permitted again: reset the recovery budget
  // and re-attempt any play() a background autoplay block left owed, so simply
  // returning to the app auto-resumes a stuck transition with no tap.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      recoverAttemptsRef.current = 0;
      retryPendingPlay();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Hydrate the persisted "hide friend duplicates" setting once, so the Settings
  // toggle and the library list share one source of truth.
  useEffect(() => {
    usePlayerStore
      .getState()
      .setHideFriendDuplicates(initialHideFriendDuplicates);
  }, [initialHideFriendDuplicates]);

  // Restore the master volume from localStorage on mount (client-only setting),
  // then allow the persist effect below to write subsequent changes.
  useEffect(() => {
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(saved) && saved >= 0 && saved <= 1) {
      usePlayerStore.getState().setVolume(saved);
    }
    volumeHydratedRef.current = true;
  }, []);

  // Persist volume changes once hydrated.
  useEffect(() => {
    if (!volumeHydratedRef.current) return;
    localStorage.setItem(VOLUME_KEY, String(volume));
  }, [volume]);

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

  // Lock-screen / hardware-key controls (MediaSession API). Wire play/pause/
  // previous/next and explicitly null the seek actions. iOS/WebKit auto-enables
  // the ±10/15s skip commands when the <audio> element becomes *seekable*, and
  // that re-enable happens at playback time, AFTER a one-time mount registration
  // has run — so nulling once at mount doesn't stick and the lock screen reverts
  // to skip buttons. We therefore re-assert this set on every play start (when
  // the element is seekable), which is when WebKit would otherwise have brought
  // the seek buttons back, so the previous/next-track arrows win.
  const applyMediaSessionHandlers = useCallback(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const { toggle, next, prev } = usePlayerStore.getState();
    session.setActionHandler("play", () => {
      if (!usePlayerStore.getState().isPlaying) {
        toggle();
        return;
      }
      // Store already intends to play but a blocked background auto-advance left
      // the element paused; this runs inside the lock-screen gesture, and the
      // session was held, so resume the element directly.
      audioRef.current?.play().catch(() => {});
    });
    session.setActionHandler("pause", () => {
      if (usePlayerStore.getState().isPlaying) toggle();
    });
    session.setActionHandler("previoustrack", prev);
    session.setActionHandler("nexttrack", next);
    for (const seek of ["seekbackward", "seekforward", "seekto"] as const) {
      try {
        session.setActionHandler(seek, null);
      } catch {
        // Unsupported action on this browser.
      }
    }
  }, []);

  useEffect(() => {
    applyMediaSessionHandlers();
    return () => {
      if (!("mediaSession" in navigator)) return;
      const session = navigator.mediaSession;
      for (const action of ["play", "pause", "previoustrack", "nexttrack"] as const) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Unsupported action.
        }
      }
    };
  }, [applyMediaSessionHandlers]);

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

  // (The OS Now Playing position + the elapsed/total readout and seek slider
  // live in <PlayerProgress>, which subscribes to currentTime/duration in
  // isolation so those 4-30 Hz ticks don't re-render this whole bar.)

  if (!track) return null;

  // The reliable total length passed to <PlayerProgress>; it reconciles this
  // against the element's own (sometimes misreported) duration.
  const serverDuration = track.durationSec ?? 0;

  const art = (size: string, iconSize: number) => (
    <div className="shrink-0">
      <TrackArt track={track} size={size} iconSize={iconSize} />
    </div>
  );

  const trackInfo = (
    <>
      <p className="truncate text-sm font-medium text-fg">{track.title}</p>
      <p className="truncate text-xs text-fg-muted">
        {track.artist ? (
          <Link
            href={`/artist?name=${encodeURIComponent(track.artist)}`}
            className="hover:text-accent-bright hover:underline"
          >
            {track.artist}
          </Link>
        ) : (
          "Unknown artist"
        )}
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
      <QueueArtPreloader />
      <NextTrackPrefetcher />
      <QueuePanel open={queueOpen} onClose={closeQueue} />
      <audio
        ref={audioRef}
        onPlaying={(e) => {
          logAudio("playing");
          pendingPlayRef.current = false; // playback truly began: nothing owed
          // Re-assert media-session handlers now that the element is seekable,
          // so WebKit's playback-time auto-enable of the ±10/15s seek commands
          // gets overridden and the previous/next-track arrows show instead.
          applyMediaSessionHandlers();
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
          const dur = e.currentTarget.duration || 0;
          // Throttle store writes to ~4 Hz: the browser fires timeupdate 4-30 Hz,
          // but the progress UI only needs ~quarter-second resolution. Push when
          // the clock moved ≥0.25s, jumped backward (seek/restart), or the
          // duration changed (first metadata / a corrected value). This is what
          // keeps the 4-30 Hz tick from re-rendering <PlayerProgress> needlessly.
          if (
            Math.abs(ct - lastProgressRef.current) >= 0.25 ||
            dur !== usePlayerStore.getState().duration
          ) {
            lastProgressRef.current = ct;
            _setProgress(ct, dur);
          }
          // Count a "friend play" once the track passes 30s (server ignores
          // the owner's own plays). Fire-and-forget; silent if offline.
          if (track && ct >= 30 && countedRef.current !== track.id) {
            countedRef.current = track.id;
            api(`/tracks/${track.id}/play`, { method: "POST" }).catch(() => {});
          }
        }}
        // Primary background-resume trigger: a prefetched next track reaches
        // canplay fast, and retryPendingPlay re-attempts the owed play() while the
        // session is held. Self-guards to a no-op on a normal successful advance.
        onCanPlay={retryPendingPlay}
        onWaiting={() => logAudio("waiting")}
        onStalled={() => {
          logAudio("stalled");
          retryPendingPlay();
        }}
        onError={onAudioError}
        onEnded={() => {
          logAudio("ended");
          autoAdvanceRef.current = true; // mark the upcoming load as automatic
          next();
        }}
      />

      {/* Mobile (below md, matching MobileNav): the desktop single row has no
          room for a usable slider, so stack a full-width seek row above a
          track-info + transport row with finger-sized targets. */}
      <div className="flex flex-col gap-1 px-4 pb-2 pt-3 md:hidden">
        <PlayerProgress className="flex" serverDuration={serverDuration} />
        <div className="flex items-center gap-2">
          {art("h-10 w-10", 18)}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <AddToPlaylistMenu
              trackIds={[track.id]}
              floating
              triggerClassName="flex h-10 w-10 items-center justify-center rounded-full text-fg-muted active:bg-surface-2"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex w-56 shrink-0 items-center gap-2">
            {art("h-11 w-11", 20)}
            <div className="min-w-0 flex-1">{trackInfo}</div>
          </div>
          <AddToPlaylistMenu
            trackIds={[track.id]}
            floating
            triggerClassName="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-white"
          />
        </div>

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

        <PlayerProgress
          className="flex min-w-0 flex-1"
          serverDuration={serverDuration}
        />

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
