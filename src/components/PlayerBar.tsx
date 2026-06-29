"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, artSrc, fetchSimilarTracks, streamSrc } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";
import { BASE_PATH } from "@/lib/base-path";
import { PREFETCH_AHEAD, prefetchUpcoming } from "@/lib/offline/prefetch";
import { loadRadioHistory, pushRadioHistory } from "@/lib/radio-history";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import { usePlaySimilarRefill } from "@/components/usePlaySimilarRefill";
import { usePlaySimilarAutoStart } from "@/components/usePlaySimilarAutoStart";
import PlayerProgress from "@/components/PlayerProgress";
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

/** localStorage key for the remembered "play similar" preference (client-only).
 *  "1" when on; the key is removed when off. */
const PLAY_SIMILAR_KEY = "wt-play-similar";

/** localStorage key for the persisted player session (queue/track/position),
 *  restored after an iOS page-lifecycle discard wipes the in-memory store. */
const SESSION_KEY = "wt-player-session";

/** Bounded retry/reload budget per track load, for background play() recovery. */
const MAX_ATTEMPTS = 4;

/**
 * Gated, removable audio instrumentation. Off by default; enable from the
 * Settings → Diagnostics toggle (or localStorage.setItem("wt-audio-debug","1")).
 * iOS audio failures are otherwise silent, so this makes the before/after of a
 * track transition observable. Lines are mirrored to localStorage under
 * `wt-audio-log` (capped) so they survive an iOS page discard and can be read
 * on-device in the Diagnostics panel without a Mac/Web Inspector; the in-memory
 * window.__wtAudioLog stays for live Web Inspector reads. Key must match
 * SettingsModal's reader.
 */
const AUDIO_LOG_KEY = "wt-audio-log";
function logAudio(event: string, detail?: string) {
  if (typeof window === "undefined") return;
  if (localStorage.getItem("wt-audio-debug") !== "1") return;
  const line = `${new Date().toISOString().slice(11, 23)} [wt-audio] ${event}${
    detail ? " " + detail : ""
  }`;
  console.info(line);
  const w = window as unknown as { __wtAudioLog?: string[] };
  (w.__wtAudioLog ??= []).push(line);
  if (w.__wtAudioLog.length > 200) w.__wtAudioLog.shift();
  // Persist so lines survive an iOS page discard and are readable in-app.
  try {
    const arr = JSON.parse(
      localStorage.getItem(AUDIO_LOG_KEY) ?? "[]"
    ) as string[];
    arr.push(line);
    while (arr.length > 200) arr.shift();
    localStorage.setItem(AUDIO_LOG_KEY, JSON.stringify(arr));
  } catch {
    // localStorage full/unavailable — in-memory buffer still holds the line.
  }
}

// The queue + now-playing overlays pull in @dnd-kit (~28 KB gz). Load that chunk
// off every authenticated page's initial JS by importing them lazily. They're
// client-only (closed = display:none / null), so ssr:false drops nothing
// visible; PlayerBar mounts them shortly after first paint (see `overlaysReady`)
// so the queue's drag tree still pre-warms before the user first opens it.
const QueuePanel = dynamic(() => import("@/components/QueuePanel"), {
  ssr: false,
});
const NowPlayingScreen = dynamic(() => import("@/components/NowPlayingScreen"), {
  ssr: false,
});

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
      // Warm the thumbnail URL the queue rows actually request, not the full art.
      img.src = artSrc(track.id, { thumb: true });
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
  // EXPERIMENT (iOS lock-screen resume): a second <audio> looping silence, played
  // through a pause so the iOS audio session is never released. A backgrounded iOS
  // PWA can't restart a paused <audio> from the lock screen (play() hangs pending);
  // keeping a real media element playing holds the session where the keep-alive
  // AudioContext tone can't (iOS suspends an AudioContext in the background). Gated
  // to the installed iOS PWA (navigator.standalone); stopped once the track resumes.
  const silenceRef = useRef<HTMLAudioElement>(null);
  // The track position to pin the OS Now Playing scrubber to while paused (the
  // silence loop is the playing element then, so iOS would otherwise show ITS
  // 0-3s position). Non-null only between a pause and the next resume.
  const pausedPosRef = useRef<number | null>(null);
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
  // Same gate for the "play similar" preference persist effect.
  const playSimilarHydratedRef = useRef(false);
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
  // Set true right before a pause WE cause (deliberate pause, end-of-queue, or a
  // src swap on a playing element) so onPause can tell our own pause from an
  // involuntary one (iOS handing the shared audio session to another PWA). Only
  // set when a 'pause' event will actually fire (element currently playing), so
  // the flag can't go stale; also cleared in onPlaying.
  const expectedPauseRef = useRef(false);
  // One-shot playhead to restore for a session rehydrated after a page discard,
  // applied in onLoadedMetadata when the element is seekable. Bound to a specific
  // track id so a restore meant for one track can't leak onto a different track
  // the user selects before it lands (which would start that track partway in).
  const restoredPositionRef = useRef<{
    trackId: string;
    position: number;
  } | null>(null);
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
  // The button lights for the remembered preference OR an active radio (e.g. one
  // started from a Discover tile, which sets no pref). The pref covers the brief
  // dip of `playSimilar` to false during an auto-start seed fetch, so the lit
  // state never flickers.
  const playSimilarPref = usePlayerStore((s) => s.playSimilarPref);
  const playSimilar = usePlayerStore((s) => s.playSimilar);
  const playSimilarOn = playSimilar || playSimilarPref;
  const [queueOpen, setQueueOpen] = useState(false);
  // Mobile-only fullscreen surfaces: the now-playing sheet (tap the mini-bar)
  // and the queue sheet it opens.
  const [npOpen, setNpOpen] = useState(false);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  // Gates the lazy queue/now-playing chunk (see the dynamic imports above):
  // mount the overlays once the page is idle so the queue's drag tree pre-warms
  // before first open — or immediately if the user opens one before idle fires.
  const [overlaysReady, setOverlaysReady] = useState(false);
  // Stable identities so transport-state changes don't re-render the memoized
  // QueuePanel through a fresh onClose each render.
  const closeQueue = useCallback(() => setQueueOpen(false), [setQueueOpen]);
  const closeNp = useCallback(() => setNpOpen(false), []);
  // Opening an overlay latches `overlaysReady` (so its chunk loads now and it
  // stays mounted through the close animation) in addition to flipping its own
  // open flag.
  const toggleQueue = useCallback(() => {
    setOverlaysReady(true);
    setQueueOpen((o) => !o);
  }, []);
  const openNp = useCallback(() => {
    setOverlaysReady(true);
    setNpOpen(true);
  }, []);
  const openMobileQueue = useCallback(() => {
    setOverlaysReady(true);
    setMobileQueueOpen(true);
  }, []);
  const closeMobileQueue = useCallback(() => setMobileQueueOpen(false), []);

  // Pre-mount the overlays once the page goes idle so the queue's drag tree is
  // already built before the user first opens it (only sets state from the
  // deferred callbacks, never synchronously in the effect body).
  useEffect(() => {
    if (overlaysReady) return;
    const ric = window.requestIdleCallback;
    if (ric) {
      const id = ric(() => setOverlaysReady(true), { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(() => setOverlaysReady(true), 1200);
    return () => clearTimeout(t);
  }, [overlaysReady]);

  // Keep the "play similar" radio's queue topped up while it's active.
  usePlaySimilarRefill();
  // Auto-start radio when a single track is played with the pref remembered on.
  usePlaySimilarAutoStart();

  // Toggle "play similar": off → seed from the current track and fetch the
  // first batch; on → stop refilling (leaving the queue as-is).
  const handlePlaySimilar = async () => {
    const store = usePlayerStore.getState();
    if (store.playSimilar || store.playSimilarPref) {
      // On (active radio and/or remembered) → forget the pref and stop the radio.
      store.stopSimilar();
      store.setPlaySimilarPref(false);
      return;
    }
    // Remember it first, so it sticks even with nothing playing yet (or a seed
    // with no embedding): the next track you click will auto-start radio.
    store.setPlaySimilarPref(true);
    if (store.index < 0) return;
    const seed = store.queue[store.index].track;
    // Pre-seed exclusions with recently-served tracks so a restart doesn't
    // replay the same neighbourhood (similarSeen is otherwise session-only).
    const history = loadRadioHistory();
    try {
      const similar = await fetchSimilarTracks(
        seed.id,
        [seed.id, ...history],
        10
      );
      // No embedding for the seed yet (or nothing similar) — stay off.
      if (similar.length === 0) return;
      usePlayerStore.getState().startSimilar(seed.id, similar, history);
      pushRadioHistory(similar.map((t) => t.id));
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
    // iOS can escalate a backgrounded context past "suspended" to the
    // non-standard "interrupted" state; resume anything that isn't running
    // (but not a closed context, whose resume() would reject).
    if (ctx.state !== "running" && ctx.state !== "closed")
      ctx.resume().catch(() => {});
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
        logAudio("play-ok");
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

  // Pin the OS Now Playing scrubber to the TRACK's real position/duration. The
  // silent keep-alive element (see silenceRef) is the actively-playing media
  // during a pause, so without this iOS derives the scrubber from ITS 0-3s loop
  // (snapping to the real spot on resume). setPositionState overrides that with
  // page-global values. Guarded: it throws on NaN/out-of-range inputs (e.g.
  // before metadata, or a streamed element whose duration is briefly Infinity).
  const updatePositionState = (positionOverride?: number) => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!("setPositionState" in navigator.mediaSession)) return;
    const audio = audioRef.current;
    if (!audio) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const raw = positionOverride ?? audio.currentTime;
    const position = Math.min(Math.max(0, raw), duration);
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position,
        playbackRate: audio.playbackRate || 1,
      });
    } catch {
      // Out-of-range mid-load — ignore; a later call corrects it.
    }
  };

  // Set the OS playback state. A plain helper (not an inline mutation inside JSX
  // event handlers) so the React Compiler immutability lint stays happy.
  const setPlaybackState = (state: "playing" | "paused") => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    // Mutating a Web-API global the React Compiler can't model as mutable (the
    // existing [isPlaying] effect does the same; effects are just exempt).
    // eslint-disable-next-line react-hooks/immutability
    navigator.mediaSession.playbackState = state;
  };

  // Re-assert a pending restore target (set by the cold-mount discard restore, or
  // by a warm same-track reload that lost its position) until the element really
  // reaches it, then clear. A single seek at loadedmetadata is NOT enough on iOS:
  // a freshly-loaded streamed element usually isn't seekable yet (seekable is
  // empty), so the seek silently no-ops and the track plays from 0. We retry on
  // each readiness event (loadedmetadata/canplay/playing/seeked) until it sticks.
  const tryRestorePosition = () => {
    const audio = audioRef.current;
    const target = restoredPositionRef.current;
    if (!audio || target == null) return;
    // A target meant for a previously-loaded track must never seek this one —
    // drop it (even before the element is seekable) so it can't fire later.
    if (target.trackId !== track?.id) {
      restoredPositionRef.current = null;
      return;
    }
    if (audio.readyState < 1) return;
    // Clamp so a value past the end can't strand us seeking forever (or fire
    // 'ended' → auto-advance).
    const clamped = Math.min(
      target.position,
      audio.duration || target.position
    );
    if (Math.abs(audio.currentTime - clamped) <= 0.5) {
      restoredPositionRef.current = null; // arrived — stop re-asserting
      return;
    }
    audio.currentTime = clamped;
    freshLoadRef.current = false; // stop onPlaying's cold-start snap-to-0
    logAudio("restore", String(clamped));
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
    // A src swap on a still-playing element queues a 'pause' event; tag it as
    // expected so onPause doesn't mistake it for an involuntary interruption.
    if (!audio.paused) expectedPauseRef.current = true;
    audio.src = streamSrc(track.id);
    freshLoadRef.current = true;
    pendingPlayRef.current = false; // a new track supersedes any owed retry
    recoverAttemptsRef.current = 0; // fresh recovery budget per track
    // Drop a restore target meant for a previous track so it neither seeks this
    // one (starting it partway through) nor blocks the warm fallback in
    // onLoadedMetadata. A cold-mount target for THIS track is kept (same id).
    if (
      restoredPositionRef.current &&
      restoredPositionRef.current.trackId !== track.id
    )
      restoredPositionRef.current = null;
    const autoAdvance = autoAdvanceRef.current;
    autoAdvanceRef.current = false; // consume the flag
    if (usePlayerStore.getState().isPlaying) attemptPlay(autoAdvance);
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    if (isPlaying) {
      // Only attempt when the element is actually paused: the lock-screen
      // 'play' handler resumes in-gesture and then flips intent, so this effect
      // would otherwise fire a redundant play() whose rejection path
      // (onPlayError(false)) could tear the freshly-resumed session back down.
      if (audio.paused) attemptPlay(false);
    } else {
      // A genuine stop (user pause or end-of-queue) neutralizes any stale
      // auto-advance arm and releases the keep-alive session. NOTE: isPlaying is
      // set false BEFORE this runs, and we tag the pause as expected — both are
      // load-bearing so onPause never treats a deliberate pause as involuntary.
      // (Keeping the keep-alive tone running through the pause was tried as a way
      // to enable a locked-screen resume — it did NOT help: a backgrounded iOS
      // PWA cannot restart <audio> regardless. So we suspend it to save the idle
      // Bluetooth cost.)
      autoAdvanceRef.current = false;
      pausedPosRef.current = audio.currentTime; // frozen position for the OS scrubber
      // EXPERIMENT: in an installed iOS PWA, start the silent loop in-gesture
      // BEFORE pausing the track so the audio session stays held across the
      // pause — the bet for enabling a locked-screen resume. onPlaying stops it
      // once the track resumes. No-op (and unstarted) anywhere but an iOS PWA.
      if ((navigator as unknown as { standalone?: boolean }).standalone === true) {
        const s = silenceRef.current;
        if (s) {
          s.currentTime = 0;
          s.play()
            .then(() => {
              logAudio("silence:play");
              // Re-assert the paused display AFTER the silence element starts:
              // iOS otherwise derives "playing" from the actively-playing loop.
              setPlaybackState("paused");
              updatePositionState(pausedPosRef.current ?? undefined);
            })
            .catch((e) => logAudio("silence:reject", (e as { name?: string })?.name));
        }
      }
      if (!audio.paused) expectedPauseRef.current = true;
      audio.pause();
      keepAliveRef.current?.suspend().catch(() => {});
      updatePositionState(pausedPosRef.current ?? undefined); // pin to frozen position
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
      logAudio("vis", document.visibilityState);
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

  // Restore the remembered "play similar" preference on mount, then let the
  // persist effect below write subsequent changes.
  useEffect(() => {
    usePlayerStore
      .getState()
      .setPlaySimilarPref(localStorage.getItem(PLAY_SIMILAR_KEY) === "1");
    playSimilarHydratedRef.current = true;
  }, []);

  // Persist preference changes once hydrated.
  useEffect(() => {
    if (!playSimilarHydratedRef.current) return;
    if (playSimilarPref) localStorage.setItem(PLAY_SIMILAR_KEY, "1");
    else localStorage.removeItem(PLAY_SIMILAR_KEY);
  }, [playSimilarPref]);

  // Persist a minimal session snapshot when the tab is backgrounded/hidden — the
  // last reliable signals before iOS freezes then discards a paused PWA. Not a
  // per-tick writer; SPA navigation keeps PlayerBar mounted and fires neither
  // event, so a live session is never clobbered.
  useEffect(() => {
    const save = () => {
      const s = usePlayerStore.getState();
      logAudio("save", `idx=${s.index}`);
      if (s.index < 0) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          tracks: s.queue.map((q) => q.track),
          index: s.index,
          currentTime: audioRef.current?.currentTime ?? s.currentTime,
          savedAt: Date.now(),
        })
      );
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };
    const onPageHide = () => {
      logAudio("pagehide");
      save();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  // On a cold mount (a real page load — e.g. iOS discarded and reloaded the app),
  // restore the snapshot PAUSED. The index<0 guard means this never runs on an
  // in-app remount where the in-memory store survived. The first tap resumes
  // (no gesture-less autoplay); the playhead is applied in onLoadedMetadata.
  useEffect(() => {
    const cold = usePlayerStore.getState().index < 0;
    const raw = localStorage.getItem(SESSION_KEY);
    logAudio("mount", `cold=${cold} snap=${raw ? "yes" : "no"}`);
    if (!cold) return; // store survived (in-app remount / thaw) — nothing to restore
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as {
        tracks: TrackDTO[];
        index: number;
        currentTime: number;
        savedAt?: number;
      };
      // Resume-on-launch, not resurrect-forever: ignore stale snapshots.
      if (s.savedAt && Date.now() - s.savedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      if (s.tracks?.length && s.index >= 0 && s.index < s.tracks.length) {
        restoredPositionRef.current =
          s.currentTime > 0
            ? { trackId: s.tracks[s.index].id, position: s.currentTime }
            : null;
        usePlayerStore
          .getState()
          .hydrateSession(s.tracks, s.index, s.currentTime);
      }
    } catch {
      // Corrupt snapshot — ignore.
    }
  }, []);

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
      restoredPositionRef.current = null; // a deliberate seek cancels a pending restore
      audio.currentTime = seekRequest;
      _clearSeek();
      updatePositionState(); // reflect the seek in the OS scrubber immediately
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
      logAudio("mediasession:play");
      // Resume INSIDE the lock-screen gesture: iOS only honors the transient
      // user activation synchronously, so deferring play()/AudioContext.resume()
      // to the [isPlaying] effect loses it (NotAllowedError -> onPlayError(false)
      // -> _setPlaying(false), tearing the session down). attemptPlay(true) wakes
      // the output and plays here; a still-blocked resume is held as an owed play
      // (onPlayError(true)) rather than torn down. Then sync intent — the effect's
      // own attempt no-ops because the element is already (being) played.
      attemptPlay(true);
      if (!usePlayerStore.getState().isPlaying) _setPlaying(true);
    });
    session.setActionHandler("pause", () => {
      logAudio("mediasession:pause");
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
    // Deps intentionally []: stable identity matters (this is a dep of the mount
    // effect and is called from onPlaying). The captured attemptPlay/_setPlaying
    // first-render copies only touch refs and a stable zustand setter, so they
    // operate on live values — no stale-closure hazard.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    const artwork = track.artS3Key
      ? [{ src: artSrc(track.id), sizes: "512x512" }]
      : [{ src: `${BASE_PATH}/icon-512.png`, sizes: "512x512", type: "image/png" }];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? undefined,
      album: track.album ?? undefined,
      artwork,
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
      <TrackArt track={track} size={size} iconSize={iconSize} thumb />
    </div>
  );

  const trackInfo = (
    <>
      <p className="truncate text-sm font-medium text-fg">{track.title}</p>
      <p className="truncate text-xs text-fg-muted">
        {track.artist ? (
          <Link
            href={`/artist?name=${encodeURIComponent(track.artist)}`}
            className="hover:text-accent-bright"
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
      {overlaysReady && (
        <>
          <QueuePanel open={queueOpen} onClose={closeQueue} variant="desktop" />
          <NowPlayingScreen
            open={npOpen}
            onClose={closeNp}
            onOpenQueue={openMobileQueue}
            onPlaySimilar={handlePlaySimilar}
          />
          <QueuePanel
            open={mobileQueueOpen}
            onClose={closeMobileQueue}
            variant="mobile"
          />
        </>
      )}
      <audio
        ref={audioRef}
        onPlaying={(e) => {
          logAudio("playing");
          pendingPlayRef.current = false; // playback truly began: nothing owed
          expectedPauseRef.current = false; // ...and no deliberate pause is pending
          pausedPosRef.current = null; // resumed: stop pinning the frozen scrubber
          silenceRef.current?.pause(); // EXPERIMENT: track holds the session now
          setPlaybackState("playing");
          updatePositionState();
          // Re-assert media-session handlers now that the element is seekable,
          // so WebKit's playback-time auto-enable of the ±10/15s seek commands
          // gets overridden and the previous/next-track arrows show instead.
          applyMediaSessionHandlers();
          // Last-chance re-assert of a pending restore (clears it once reached);
          // when it fires it clears freshLoadRef, so the cold-start snap-to-0
          // below is skipped and the restored position survives.
          tryRestorePosition();
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
            updatePositionState(); // keep the OS scrubber in step while playing
            // Re-assert "playing" while the track ticks so the lock-screen
            // button self-corrects after a resume (it otherwise lingers on the
            // play icon — iOS latched a paused state when the silence loop
            // stopped). onTimeUpdate only fires while the track is playing.
            setPlaybackState("playing");
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
        // Also the main re-assert point for a pending restore: by canplay the
        // element is finally seekable, so the cold-mount/resume seek lands here
        // even when it no-opped at loadedmetadata.
        onCanPlay={() => {
          tryRestorePosition();
          retryPendingPlay();
        }}
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
        onPause={() => {
          const audio = audioRef.current;
          if (!audio) return;
          const playing = usePlayerStore.getState().isPlaying;
          // Log every pause with its inputs so we can see, on-device, whether a
          // lock-screen pause even reaches here (vs the MediaSession 'pause'
          // handler) and how it gets classified.
          logAudio(
            "pause",
            `exp=${expectedPauseRef.current} ended=${audio.ended} playing=${playing} vis=${document.visibilityState}`
          );
          // Our own pauses (user/lock-screen pause, end-of-queue, src swap) are
          // pre-tagged — consume the tag and ignore them.
          if (expectedPauseRef.current) {
            expectedPauseRef.current = false;
            return;
          }
          if (audio.ended) return; // natural track end → onEnded advances
          if (!playing) return; // intent already paused
          // Reality (paused) diverged from intent (playing) with no deliberate
          // cause: an involuntary/system pause.
          if (document.visibilityState === "visible") {
            // Foreground interruption (headphone unplug, call, audio-focus loss):
            // the user/OS meant it — reconcile UI to reality, don't fight the OS.
            logAudio("pause:fg-reconcile");
            _setPlaying(false);
            return;
          }
          // Backgrounded (the iOS shared-session handoff when another PWA closes):
          // reclaim playback. Arm the owed play and retry; a still-blocked
          // background play() re-arms via onPlayError(true) and the existing
          // visibilitychange path resumes on return to the foreground.
          logAudio("pause:bg-reclaim");
          pendingPlayRef.current = true;
          retryPendingPlay();
        }}
        onLoadedMetadata={() => {
          // Restore the playhead once the element is seekable (done here, not via
          // seekRequest, which the seek effect clears before first play). The seek
          // is re-asserted across readiness events by tryRestorePosition because a
          // single one rarely sticks on a freshly-loaded streamed element on iOS.
          const audio = audioRef.current;
          if (!audio) return;
          // No explicit cold-mount target, but the element came back at ~0 while
          // the store knows we were further into THIS track — a warm same-track
          // reload that lost its position (iOS evicts a backgrounded PWA's media
          // resource on resume; or an expired-presigned-URL re-buffer errors and
          // onAudioError reload()s from the top). Adopt the store position as the
          // restore target. Fresh tracks reset store.currentTime to 0 (playQueue/
          // playAt/next/prev), so the `stored > 1` guard keeps this off for them.
          if (restoredPositionRef.current == null) {
            const stored = usePlayerStore.getState().currentTime;
            if (stored > 1 && audio.currentTime < 0.5)
              restoredPositionRef.current = { trackId: track.id, position: stored };
          }
          tryRestorePosition();
          updatePositionState(); // seed the OS scrubber before first playback
        }}
        onSeeked={tryRestorePosition}
      />
      {/* EXPERIMENT: silent loop kept playing through a pause to hold the iOS
          audio session (see silenceRef). Played/paused imperatively; renders
          harmlessly everywhere but only ever plays in an installed iOS PWA. */}
      <audio
        ref={silenceRef}
        src={`${BASE_PATH}/silence.m4a`}
        loop
        preload="auto"
        onTimeUpdate={() => {
          // The silence loop is the actively-playing element during a pause, so
          // iOS derives the Now Playing scrubber/state from IT (a 0-3s loop) and
          // ignores a one-shot override. Re-pin to the track's frozen position
          // and re-assert paused on every tick to keep overriding that.
          if (pausedPosRef.current == null) return;
          updatePositionState(pausedPosRef.current);
          setPlaybackState("paused");
        }}
      />

      {/* Mobile (below md, matching MobileNav): a minimal mini-player — art +
          title/artist on the left (tap to open the now-playing sheet),
          rewind/play/skip on the right, and a thin non-interactive progress
          line underneath (also taps through to the sheet). */}
      <div className="flex flex-col gap-2 px-4 pb-2 pt-3 md:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={openNp}
            aria-label="Open now playing"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {art("h-10 w-10", 18)}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">
                {track.title}
              </p>
              <p className="truncate text-xs text-fg-muted">
                {track.artist || "Unknown artist"}
                {track.ownerName ? ` · from ${track.ownerName}` : ""}
              </p>
            </div>
          </button>
          <div className="flex shrink-0 items-center gap-1">
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
          </div>
        </div>
        <button
          onClick={openNp}
          aria-label="Open now playing"
          className="w-full"
        >
          <PlayerProgress
            barOnly
            className="flex w-full"
            serverDuration={serverDuration}
          />
        </button>
      </div>

      {/* Desktop (md and up): the original single row, unchanged. */}
      <div className="hidden items-center gap-3 py-3 pl-4 pr-6 md:flex">
        <div className="flex w-56 shrink-0 items-center gap-2">
          {art("h-11 w-11", 20)}
          <div className="min-w-0 flex-1">{trackInfo}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <AddToPlaylistMenu
            trackIds={[track.id]}
            floating
            triggerClassName="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-white"
          />
          {transportButton(
            toggleQueue,
            queueOpen ? "Hide queue" : "Show queue",
            <QueueIcon size={16} />,
            `h-10 w-10 hover:bg-surface-2 ${
              queueOpen
                ? "text-accent-bright hover:text-accent-bright"
                : "text-fg-muted hover:text-white"
            }`
          )}
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
            playSimilarOn ? "Stop play similar" : "Play similar",
            <SimilarIcon size={16} />,
            `h-10 w-10 hover:bg-surface-2 ${
              playSimilarOn
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
