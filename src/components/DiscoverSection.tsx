"use client";

import { useState } from "react";
import {
  CheckIcon,
  PlayIcon,
  PlusIcon,
  ShuffleIcon,
  SimilarIcon,
} from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import { Button } from "@/components/ui/Button";
import { api, fetchSimilarTracks } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";

type SaveState = "idle" | "saving" | "done" | "error";

/** Number of tappable rows shown; the rest of the pool stays the context. */
const PREVIEW = 3;

const CARD = "rounded-xl border border-border-subtle bg-surface-1 p-4 sm:p-5";

/** Action-button glyph: larger on mobile (label hidden), smaller with text on >=sm. */
const ICON = "h-5 w-5 sm:h-3.5 sm:w-3.5";

/** Fisher-Yates copy, used when a tapped seed has no embedding to rank by. */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function Row({
  track,
  isCurrent,
  onPlay,
}: {
  track: TrackDTO;
  isCurrent: boolean;
  onPlay: () => void;
}) {
  return (
    <li>
      <button
        onClick={onPlay}
        title={`Play ${track.title}`}
        className={`group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-2/60 ${
          isCurrent ? "text-accent-bright" : "text-fg"
        }`}
      >
        <TrackArt track={track} size="h-10 w-10" iconSize={18} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium group-hover:text-accent-bright">
            {track.title}
          </span>
          <span className="block truncate text-xs text-fg-muted">
            {track.artist ?? "Unknown artist"}
            {track.ownerName ? ` · ${track.ownerName}` : ""}
          </span>
        </span>
        {/* Marks that a tap starts a similar mix from this list. */}
        <SimilarIcon size={15} className="shrink-0 text-fg-subtle" />
      </button>
    </li>
  );
}

/**
 * One Discover section as a card. The buttons act on the whole pool; tapping a
 * row plays that song then continues with a similarity mix drawn only from this
 * section, so the pick carries past the first track. The Random variant
 * (radioSeed) launches the whole-library radio without revealing the track.
 *
 * Display order is the server order (no render-time shuffle, which would desync
 * SSR from hydration); Shuffle randomizes playback.
 */
export default function DiscoverSection({
  title,
  description,
  tracks,
  radioSeed,
  emptyHint,
}: {
  title: string;
  /** One-line tagline under the title. */
  description?: string;
  tracks?: TrackDTO[];
  /** When set, this is the Random section: a hidden seed whose play starts the
   *  whole-library radio. */
  radioSeed?: TrackDTO | null;
  /** Shown below the description when the section has no tracks. */
  emptyHint?: string;
}) {
  const current = useCurrentTrack();
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const Description = description ? (
    <p className="text-xs text-fg-muted">{description}</p>
  ) : null;

  // Random: a hidden seed; play starts the whole-library radio.
  if (radioSeed !== undefined) {
    if (!radioSeed) {
      return (
        <section className={CARD}>
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          {Description}
          {emptyHint && (
            <p className="mt-1 text-xs text-fg-subtle">{emptyHint}</p>
          )}
        </section>
      );
    }
    const seed = radioSeed;
    const playRadio = async () => {
      usePlayerStore.getState().playQueue([seed], 0);
      try {
        const similar = await fetchSimilarTracks(seed.id, [seed.id], 10);
        if (similar.length) {
          usePlayerStore.getState().startSimilar(seed.id, similar);
        }
      } catch {
        // Leave it as a single-track queue on failure.
      }
    };
    return (
      <section className={CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto font-display text-lg font-semibold">{title}</h2>
          <Button size="sm" pill onClick={playRadio}>
            <PlayIcon className={ICON} />
            Play radio
          </Button>
        </div>
        {Description}
      </section>
    );
  }

  const pool = tracks ?? [];

  // Empty list section: keep the card visible with the tagline and a short note.
  if (pool.length === 0) {
    return (
      <section className={CARD}>
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {Description}
        {emptyHint && <p className="mt-1 text-xs text-fg-subtle">{emptyHint}</p>}
      </section>
    );
  }

  const preview = pool.slice(0, PREVIEW);

  const play = () => usePlayerStore.getState().playQueue(pool, 0);

  const shuffle = () => {
    usePlayerStore.setState({ shuffled: true });
    usePlayerStore
      .getState()
      .playQueue(pool, Math.floor(Math.random() * pool.length));
  };

  // Tap a song: play it now, then queue the rest of this section ranked by
  // similarity to it (or shuffled, if it has no embedding to rank by).
  const playFromSong = async (track: TrackDTO) => {
    usePlayerStore.setState({ shuffled: false });
    usePlayerStore.getState().playQueue([track], 0);
    const rest = pool.filter((t) => t.id !== track.id);
    let mix = shuffled(rest);
    try {
      const similar = await fetchSimilarTracks(
        track.id,
        [track.id],
        Math.min(50, rest.length),
        pool.map((t) => t.id)
      );
      if (similar.length) mix = similar;
    } catch {
      // Keep the shuffled fallback.
    }
    // Append only if our seed is still the lone current track (the user hasn't
    // tapped something else, and we have not already appended).
    const s = usePlayerStore.getState();
    if (s.queue.length === 1 && s.queue[s.index]?.track.id === track.id) {
      s.addToQueue(mix);
    }
  };

  const save = async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    try {
      const name = `${title} (${new Date().toLocaleDateString()})`.slice(0, 100);
      const playlist = await api<PlaylistDTO>("/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await api(`/playlists/${playlist.id}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: pool.slice(0, 500).map((t) => t.id) }),
      });
      setSaveState("done");
    } catch {
      setSaveState("error");
    }
  };

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-display text-lg font-semibold">
          {title}
          <span className="ml-2 text-xs font-normal text-fg-subtle">
            {pool.length}
          </span>
        </h2>
        <Button size="sm" pill onClick={play} aria-label="Play">
          <PlayIcon className={ICON} />
          <span className="hidden sm:inline">Play</span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          pill
          onClick={shuffle}
          aria-label="Shuffle"
        >
          <ShuffleIcon className={ICON} />
          <span className="hidden sm:inline">Shuffle</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          pill
          onClick={save}
          disabled={saveState === "saving" || saveState === "done"}
          aria-label={saveState === "done" ? "Saved" : "Save"}
        >
          {saveState === "done" ? (
            <CheckIcon className={ICON} />
          ) : (
            <PlusIcon className={ICON} />
          )}
          <span className="hidden sm:inline">
            {saveState === "done"
              ? "Saved"
              : saveState === "saving"
                ? "Saving"
                : saveState === "error"
                  ? "Retry"
                  : "Save"}
          </span>
        </Button>
      </div>

      {description && (
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      )}
      <p className="mb-2 mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
        <SimilarIcon size={13} />
        Tap a song to play it, then a similar mix from this list.
      </p>

      <ul>
        {preview.map((track) => (
          <Row
            key={track.id}
            track={track}
            isCurrent={current?.id === track.id}
            onPlay={() => playFromSong(track)}
          />
        ))}
      </ul>

      {pool.length > preview.length && (
        <p className="mt-1 px-2 text-xs text-fg-subtle">
          +{pool.length - preview.length} more
        </p>
      )}
    </section>
  );
}
