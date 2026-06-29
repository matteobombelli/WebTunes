"use client";

import { useState } from "react";
import { CheckIcon, PlayIcon, PlusIcon, ShuffleIcon } from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import { Button } from "@/components/ui/Button";
import { api, fetchSimilarTracks } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";

type SaveState = "idle" | "saving" | "done" | "error";

/** Album-art tiles: a 2x2 grid on mobile; up to two rows of six on desktop. */
const PREVIEW = 12;

/** Action-button glyph: larger on mobile (label hidden), smaller with text on >=sm. */
const ICON = "h-6 w-6 sm:h-4 sm:w-4";

/**
 * One Discover section. Sections blend into the page (no card chrome); spacing
 * between them comes from the parent. The buttons act on the whole pool; tapping
 * an album-art tile plays that song then starts a full-library "play similar"
 * radio seeded from it. Pass `radioSeeds` instead of `tracks` to render the
 * section as a single "Play Radio" button (used by Random).
 *
 * Display order is the server order (no render-time shuffle, which would desync
 * SSR from hydration); Shuffle randomizes playback.
 */
export default function DiscoverSection({
  title,
  tracks,
  radioSeeds,
  showCount = true,
  emptyHint,
}: {
  title: string;
  tracks?: TrackDTO[];
  /** When set, render this pool as a single "Play Radio" button (used by Random)
   *  instead of the art grid. */
  radioSeeds?: TrackDTO[];
  /** Show the track-count next to the title. Off for the Random pool, where a
   *  count is meaningless. */
  showCount?: boolean;
  /** Shown when the section has no tracks. */
  emptyHint?: string;
}) {
  const current = useCurrentTrack();
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // Random: the whole section is one big, easy-to-press "Play Radio" button.
  if (radioSeeds !== undefined) {
    if (radioSeeds.length === 0) return null;
    const seeds = radioSeeds;
    const playRadio = async () => {
      // Fresh seed per tap so the radio varies even from the router cache.
      const seed = seeds[Math.floor(Math.random() * seeds.length)];
      usePlayerStore.getState().playQueue([seed], 0);
      try {
        const similar = await fetchSimilarTracks(seed.id, [seed.id], 10);
        if (similar.length)
          usePlayerStore.getState().startSimilar(seed.id, similar);
      } catch {
        // Leave it as a single-track queue on failure.
      }
    };
    return (
      <section>
        <h2 className="mb-3 font-display text-lg font-semibold sm:text-[1.6875rem]">
          {title}
        </h2>
        <button
          onClick={playRadio}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-4 font-display text-base font-semibold text-accent-fg transition hover:bg-accent-hover"
        >
          <PlayIcon size={20} />
          Play Radio
        </button>
      </section>
    );
  }

  const pool = tracks ?? [];

  if (pool.length === 0) {
    return (
      <section>
        <h2 className="font-display text-lg font-semibold sm:text-[1.6875rem]">{title}</h2>
        {emptyHint && <p className="mt-1 text-xs text-fg-subtle">{emptyHint}</p>}
      </section>
    );
  }

  const preview = pool.slice(0, PREVIEW);

  const play = () =>
    usePlayerStore.getState().playQueue(pool, 0, { collection: true });

  const shuffle = () => {
    usePlayerStore.setState({ shuffled: true });
    usePlayerStore
      .getState()
      .playQueue(pool, Math.floor(Math.random() * pool.length), {
        collection: true,
      });
  };

  // Tap a song: play it, then start a full-library "play similar" radio seeded
  // from it (auto-refilling, ranked by CLAP cosine — keeps the genre coherent).
  const playFromSong = async (track: TrackDTO) => {
    usePlayerStore.getState().playQueue([track], 0);
    try {
      const similar = await fetchSimilarTracks(track.id, [track.id], 10);
      if (similar.length)
        usePlayerStore.getState().startSimilar(track.id, similar);
    } catch {
      // Leave it as a single-track queue on failure.
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
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-display text-lg font-semibold sm:text-[1.6875rem]">
          {title}
          {showCount && (
            <span className="ml-2 text-xs font-normal text-fg-subtle">
              {pool.length}
            </span>
          )}
        </h2>
        <Button size="md" pill onClick={play} aria-label="Play">
          <PlayIcon className={ICON} />
          <span className="hidden sm:inline">Play</span>
        </Button>
        <Button
          size="md"
          variant="secondary"
          pill
          onClick={shuffle}
          aria-label="Shuffle"
        >
          <ShuffleIcon className={ICON} />
          <span className="hidden sm:inline">Shuffle</span>
        </Button>
        <Button
          size="md"
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        {preview.map((track, i) => (
          <button
            key={track.id}
            onClick={() => playFromSong(track)}
            title={track.title}
            className={`relative aspect-square w-full overflow-hidden rounded-lg bg-surface-2 transition duration-200 ease-out hover:z-10 hover:-translate-y-1 hover:shadow-xl hover:shadow-black/40 ${
              i >= 4 ? "hidden sm:block" : ""
            } ${current?.id === track.id ? "ring-2 ring-accent" : ""}`}
          >
            <TrackArt track={track} size="h-full w-full" iconSize={32} />
            {/* Darken the bottom third and label it with the song name only. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-1/3 items-end bg-[linear-gradient(to_top,rgba(0,0,0,0.8),rgba(0,0,0,0.65)_30%,rgba(0,0,0,0.45)_55%,rgba(0,0,0,0.2)_80%,transparent)] px-2 pb-2">
              <span className="w-full truncate text-left text-[1.2rem] font-medium text-white sm:text-[1.05rem]">
                {track.title}
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
