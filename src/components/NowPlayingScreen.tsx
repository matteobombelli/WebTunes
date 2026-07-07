"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore, useCurrentTrack } from "@/stores/player";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useArtGradient } from "@/lib/use-dominant-color";
import CurrentTrackDetails from "@/components/CurrentTrackDetails";
import PlayerProgress from "@/components/PlayerProgress";
import { AddToPlaylistMenu, CurrentTrackKebab } from "@/components/TrackMenus";
import {
  ChevronDownIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  ShuffleIcon,
  SimilarIcon,
} from "@/components/icons";

const EXIT_MS = 220; // matches the sheet's 0.22s inline slide transition
const DISMISS_PX = 90; // swipe-down past this (on release) dismisses

/**
 * Mobile-only fullscreen "now playing" sheet. Slides up from the bottom when the
 * mini-bar is tapped; dismissed by the down-chevron or a swipe-down. The whole
 * sheet position is an inline transform so a drag can follow the finger and the
 * open/close slide reuses the same transition (no keyframe/inline conflict).
 */
export default function NowPlayingScreen({
  open,
  onClose,
  onOpenQueue,
  onPlaySimilar,
}: {
  open: boolean;
  onClose: () => void;
  onOpenQueue: () => void;
  onPlaySimilar: () => void;
}) {
  const track = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const shuffled = usePlayerStore((s) => s.shuffled);
  // Mirrors PlayerBar: the button lights for the remembered preference or an
  // active radio (e.g. one started from a Discover tile).
  const playSimilarPref = usePlayerStore((s) => s.playSimilarPref);
  const playSimilar = usePlayerStore((s) => s.playSimilar);
  const playSimilarOn = playSimilar || playSimilarPref;
  const { toggle, next, prev, toggleShuffle } = usePlayerStore.getState();

  // closing: kept in the DOM briefly after close for the slide-down.
  // atRest: at the open position (translateY 0); false => off-screen (100%).
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  const [atRest, setAtRest] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragYRef = useRef(0);
  const startYRef = useRef<number | null>(null);

  // Derive the open/close transition during render (no setState in an effect):
  // opening resets to the off-screen start; closing keeps the node mounted so
  // its slide-down can play before it unmounts.
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setClosing(false);
      setAtRest(false);
      setDragY(0);
    } else {
      setClosing(true);
    }
  }

  const mounted = open || closing;

  // Only derive the cover gradient while the sheet is on-screen. Otherwise this
  // hook re-fetches /art-url and re-downloads the full-res cover (then re-runs a
  // canvas decode) on every track change even when the sheet is closed — which
  // is always, on desktop, where it's `md:hidden`. Gating on `mounted` (not
  // `open`) keeps the gradient through the close slide so the bg doesn't flash.
  const gradient = useArtGradient(mounted ? track : null);

  // Drive the slide via rAF/timeout callbacks (never a synchronous setState in
  // the effect body): a frame after mount, move to rest (up); on close, drop
  // the rest flag (down) and unmount once the animation has finished.
  useEffect(() => {
    if (open) {
      dragYRef.current = 0;
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setAtRest(true));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    const r = requestAnimationFrame(() => setAtRest(false));
    const t = setTimeout(() => setClosing(false), EXIT_MS);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [open]);

  // Lock body scroll while the sheet is mounted (same hook as Dialog).
  useBodyScrollLock(mounted);

  if (!mounted || !track) return null;

  // Attached to the whole sheet (nothing in it scrolls — body scroll is locked
  // above), so a downward swipe dismisses from anywhere. Gestures starting on a
  // control are ignored: a seek-slider scrub must not also drag the sheet.
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => {
      if ((e.target as HTMLElement).closest("button, input, a")) return;
      startYRef.current = e.touches[0].clientY;
      dragYRef.current = 0;
      setDragging(true);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (startYRef.current == null) return;
      const dy = Math.max(0, e.touches[0].clientY - startYRef.current);
      dragYRef.current = dy;
      setDragY(dy);
    },
    onTouchEnd: () => {
      if (startYRef.current == null) return;
      setDragging(false);
      startYRef.current = null;
      if (dragYRef.current > DISMISS_PX) onClose();
      else setDragY(0);
    },
    // A system-interrupted swipe (iOS edge gesture, incoming call) fires
    // touchcancel, not touchend — reset so it can't pin `dragging` (which would
    // kill the next slide's transition) or strand a past-threshold dragY that a
    // later tap would read as a dismiss.
    onTouchCancel: () => {
      setDragging(false);
      startYRef.current = null;
      dragYRef.current = 0;
      setDragY(0);
    },
  };

  const offset = atRest ? `${dragY}px` : "100%";

  const iconBtn = (
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
    <div
      {...swipe}
      className="fixed inset-0 z-50 flex flex-col bg-surface-1 md:hidden"
      style={{
        background: gradient ?? undefined,
        transform: `translateY(${offset})`,
        transition: dragging ? "none" : "transform 0.22s ease",
      }}
    >
      <div className="flex shrink-0 justify-center pb-1 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="h-1.5 w-10 rounded-full bg-white/30" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center gap-6 px-6">
        <div className="flex justify-center">
          <CurrentTrackDetails
            track={track}
            align="center"
            artSize="h-[min(88vw,46vh)] w-[min(88vw,46vh)]"
            iconSize={110}
            onNavigate={onClose}
            trailing={<CurrentTrackKebab track={track} onNavigate={onClose} />}
          />
        </div>

        <PlayerProgress className="flex" serverDuration={track.durationSec ?? 0} />

        <div className="flex items-center justify-center gap-8">
          {iconBtn(
            prev,
            "Previous",
            <PrevIcon size={30} />,
            "h-16 w-16 text-white active:bg-white/10"
          )}
          {iconBtn(
            toggle,
            isPlaying ? "Pause" : "Play",
            isPlaying ? <PauseIcon size={36} /> : <PlayIcon size={36} />,
            "h-20 w-20 bg-accent text-accent-fg shadow-lg shadow-accent/40 active:bg-accent-hover"
          )}
          {iconBtn(
            next,
            "Next",
            <NextIcon size={30} />,
            "h-16 w-16 text-white active:bg-white/10"
          )}
        </div>

        <div className="flex items-center justify-between">
          <AddToPlaylistMenu
            trackIds={[track.id]}
            floating
            iconSize={30}
            triggerClassName="flex h-16 w-16 items-center justify-center rounded-full text-white/80 active:bg-white/10"
          />
          {iconBtn(
            toggleShuffle,
            shuffled ? "Disable shuffle" : "Enable shuffle",
            <ShuffleIcon size={30} />,
            `h-16 w-16 active:bg-white/10 ${
              shuffled ? "text-accent-bright" : "text-white/80"
            }`
          )}
          {iconBtn(
            onPlaySimilar,
            playSimilarOn ? "Stop play similar" : "Play similar",
            <SimilarIcon size={30} />,
            `h-16 w-16 active:bg-white/10 ${
              playSimilarOn ? "text-accent-bright" : "text-white/80"
            }`
          )}
          {iconBtn(
            onOpenQueue,
            "Show queue",
            <QueueIcon size={30} />,
            "h-16 w-16 text-white/80 active:bg-white/10"
          )}
        </div>
      </div>

      <div className="flex shrink-0 justify-center pb-[calc(env(safe-area-inset-bottom)+1.75rem)] pt-2">
        <button
          onClick={onClose}
          aria-label="Close now playing"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-white/80 active:bg-white/10"
        >
          <ChevronDownIcon size={18} />
          Close
        </button>
      </div>
    </div>
  );
}
