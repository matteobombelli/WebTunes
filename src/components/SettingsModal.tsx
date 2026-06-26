"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import { api } from "@/lib/api";
import { usePlayerStore } from "@/stores/player";
import Dialog from "@/components/Dialog";

// Audio diagnostics: keys must match PlayerBar's logAudio (wt-audio-debug gate
// + wt-audio-log buffer). Surfaced here so iOS playback events can be read on
// the device (no console/Web Inspector on an installed PWA).
const AUDIO_DEBUG_KEY = "wt-audio-debug";
const AUDIO_LOG_KEY = "wt-audio-log";

function readAudioLog(): string {
  try {
    const arr = JSON.parse(
      localStorage.getItem(AUDIO_LOG_KEY) ?? "[]"
    ) as string[];
    return arr.join("\n");
  } catch {
    return "";
  }
}

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
  userName,
}: {
  initialSimilarVariation: number;
  userEmail: string;
  userName: string | null;
}) {
  const router = useRouter();
  const open = usePlayerStore((s) => s.settingsOpen);
  const normalizeVolume = usePlayerStore((s) => s.normalizeVolume);
  const similarDrift = usePlayerStore((s) => s.similarDrift);
  const hideFriendDuplicates = usePlayerStore((s) => s.hideFriendDuplicates);
  const [variation, setVariation] = useState(initialSimilarVariation);
  const [name, setName] = useState(userName ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [audioDebug, setAudioDebug] = useState(false);
  const [audioLog, setAudioLog] = useState("");
  const [logCopied, setLogCopied] = useState(false);

  // Sync the diagnostics UI from localStorage when the modal opens. localStorage
  // can't be read during SSR or in a lazy initializer (hydration mismatch), so a
  // one-time sync-on-open is the right place; the extra render is negligible.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setAudioDebug(localStorage.getItem(AUDIO_DEBUG_KEY) === "1");
    setAudioLog(readAudioLog());
    setLogCopied(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const close = () => usePlayerStore.getState().setSettingsOpen(false);

  const toggleAudioDebug = (value: boolean) => {
    localStorage.setItem(AUDIO_DEBUG_KEY, value ? "1" : "0");
    setAudioDebug(value);
    if (value) setAudioLog(readAudioLog());
  };

  const copyAudioLog = async () => {
    const text = readAudioLog();
    setAudioLog(text);
    try {
      await navigator.clipboard.writeText(text);
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 1500);
    } catch {
      // Clipboard blocked — the log is still on screen to copy manually.
    }
  };

  const clearAudioLog = () => {
    localStorage.removeItem(AUDIO_LOG_KEY);
    setAudioLog("");
  };

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

  const trimmedName = name.trim();
  const nameUnchanged = trimmedName === (userName ?? "");

  const saveName = async () => {
    if (!trimmedName || nameUnchanged || savingName) return;
    setSavingName(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await api("/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      });
      setNameSaved(true);
      router.refresh(); // re-render the Sidebar etc. with the new name
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Could not save name");
    } finally {
      setSavingName(false);
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
    <Dialog title="Settings" open={open} onClose={close}>
        <div className="mb-5 border-b border-border pb-5">
          <label
            htmlFor="display-name"
            className="block text-sm text-fg"
          >
            Display name
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="display-name"
              type="text"
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                setNameSaved(false);
                setNameError(null);
              }}
              placeholder="Your name"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg outline-none focus:border-accent"
            />
            <button
              onClick={saveName}
              disabled={!trimmedName || nameUnchanged || savingName}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingName ? "Saving…" : "Save"}
            </button>
          </div>
          {nameError ? (
            <p className="mt-1 text-xs text-red-400">{nameError}</p>
          ) : nameSaved ? (
            <p className="mt-1 text-xs text-accent-bright">Name updated.</p>
          ) : (
            <p className="mt-1 text-xs text-fg-muted">
              Shown to your friends and on your tracks.
            </p>
          )}
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
          <h3 className="text-sm font-semibold text-fg">Diagnostics</h3>
          <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={audioDebug}
              onChange={(e) => toggleAudioDebug(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Audio debug logging
          </label>
          <p className="mt-1 text-xs text-fg-muted">
            Records lock-screen / background playback events (survives the app
            being closed). Reproduce the issue, then copy the log and send it.
          </p>
          {audioDebug && (
            <div className="mt-2">
              <div className="mb-1 flex gap-2">
                <button
                  onClick={copyAudioLog}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-white"
                >
                  {logCopied ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={() => setAudioLog(readAudioLog())}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-white"
                >
                  Refresh
                </button>
                <button
                  onClick={clearAudioLog}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-white"
                >
                  Clear
                </button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 p-2 text-[10px] leading-relaxed text-fg-muted">
                {audioLog || "No events logged yet."}
              </pre>
            </div>
          )}
        </div>

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
    </Dialog>
  );
}
