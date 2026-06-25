"use client";

import { useState } from "react";
import { signOutAction } from "@/app/(auth)/actions";
import { api } from "@/lib/api";
import { usePlayerStore } from "@/stores/player";
import { XIcon } from "@/components/icons";

// Indexed by users.similar_variation (0..4); must match SIGMA_BY_VARIATION in
// lib/similar.ts (0 = most random … 4 = deterministic cosine).
const VARIATION_LABELS = [
  "Very random",
  "More random",
  "Balanced",
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
  userEmail,
}: {
  initialSimilarVariation: number;
  userEmail: string;
}) {
  const open = usePlayerStore((s) => s.settingsOpen);
  const normalizeVolume = usePlayerStore((s) => s.normalizeVolume);
  const similarDrift = usePlayerStore((s) => s.similarDrift);
  const hideFriendDuplicates = usePlayerStore((s) => s.hideFriendDuplicates);
  const [variation, setVariation] = useState(initialSimilarVariation);
  const [confirming, setConfirming] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const toggleHideDuplicates = async (value: boolean) => {
    usePlayerStore.getState().setHideFriendDuplicates(value);
    try {
      await api("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideFriendDuplicates: value }),
      });
    } catch {
      usePlayerStore.getState().setHideFriendDuplicates(!value); // revert on failure
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

  const emailMatches =
    emailInput.trim().toLowerCase() === userEmail.toLowerCase();

  const deleteAccount = async () => {
    if (!emailMatches || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api("/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput }),
      });
      await signOutAction(); // clears the cookie and redirects to /login
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Deletion failed");
      setDeleting(false);
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

        <label className="mt-5 flex cursor-pointer select-none items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={hideFriendDuplicates}
            onChange={(e) => toggleHideDuplicates(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Hide duplicates from friends&apos; libraries
        </label>
        <p className="mt-1 text-xs text-fg-muted">
          Hides friends&apos; tracks that match one already in your library when
          browsing everything or friends.
        </p>

        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-red-400">Danger zone</h3>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="mt-2 rounded-md border border-red-500/40 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete account
            </button>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-fg-muted">
                This permanently deletes your account, tracks, and playlists.
                Type <span className="text-fg">{userEmail}</span> to confirm.
              </p>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="Type your email to confirm"
                autoComplete="off"
                className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg outline-none focus:border-red-500/60"
              />
              {deleteError && (
                <p className="text-xs text-red-400">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={deleteAccount}
                  disabled={!emailMatches || deleting}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {deleting ? "Deleting…" : "Delete account"}
                </button>
                <button
                  onClick={() => {
                    setConfirming(false);
                    setEmailInput("");
                    setDeleteError(null);
                  }}
                  disabled={deleting}
                  className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
