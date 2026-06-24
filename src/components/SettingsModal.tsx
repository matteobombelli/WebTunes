"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { usePlayerStore } from "@/stores/player";
import { XIcon } from "@/components/icons";

// Indexed by users.similar_variation (0..4); must match SIGMA_BY_VARIATION in
// lib/similar.ts (0 = most random … 4 = deterministic cosine).
const VARIATION_LABELS = [
  "Very random",
  "More random",
  "Default",
  "More uniform",
  "Pure uniform",
];

/**
 * Global settings modal (volume normalization + "play similar" variation).
 * Rendered once in the app layout and self-gated on the player store's
 * `settingsOpen`, so it's reachable whether or not a track is playing.
 */
export default function SettingsModal({
  initialSimilarVariation,
}: {
  initialSimilarVariation: number;
}) {
  const open = usePlayerStore((s) => s.settingsOpen);
  const normalizeVolume = usePlayerStore((s) => s.normalizeVolume);
  const similarDrift = usePlayerStore((s) => s.similarDrift);
  const [variation, setVariation] = useState(initialSimilarVariation);

  if (!open) return null;
  const close = () => usePlayerStore.getState().setSettingsOpen(false);

  const toggleNormalize = async (value: boolean) => {
    usePlayerStore.getState().setNormalizeVolume(value);
    try {
      await api("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ normalizeVolume: value }),
      });
    } catch {
      usePlayerStore.getState().setNormalizeVolume(!value); // revert on failure
    }
  };

  const toggleDrift = async (value: boolean) => {
    usePlayerStore.getState().setSimilarDrift(value);
    try {
      await api("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ similarDrift: value }),
      });
    } catch {
      usePlayerStore.getState().setSimilarDrift(!value); // revert on failure
    }
  };

  const changeVariation = async (value: number) => {
    const prev = variation;
    setVariation(value);
    try {
      await api("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ similarVariation: value }),
      });
    } catch {
      setVariation(prev); // revert on failure
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Settings</h2>
          <button
            aria-label="Close settings"
            onClick={close}
            className="text-fg-muted hover:text-white"
          >
            <XIcon size={18} />
          </button>
        </div>

        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={normalizeVolume}
            onChange={(e) => toggleNormalize(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Normalize volume across tracks
        </label>

        <label className="mt-4 flex cursor-pointer select-none items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={similarDrift}
            onChange={(e) => toggleDrift(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Play similar follows the current track
        </label>
        <p className="mt-1 text-xs text-fg-muted">
          On, the radio drifts as it plays; off, it stays anchored to the track
          you started from.
        </p>

        <div className="mt-5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm text-fg">Play similar variation</span>
            <span className="text-xs text-accent-bright">
              {VARIATION_LABELS[variation]}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={4}
            step={1}
            value={variation}
            onChange={(e) => changeVariation(Number(e.target.value))}
            className="w-full accent-accent"
            aria-label="Play similar variation"
          />
          <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
            <span>Random</span>
            <span>Uniform</span>
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            Higher variation mixes in less-similar tracks so the radio differs
            each time; &ldquo;Pure uniform&rdquo; always plays the closest
            matches.
          </p>
        </div>
      </div>
    </div>
  );
}
