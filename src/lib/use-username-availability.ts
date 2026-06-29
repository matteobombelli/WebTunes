"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type NameAvailability = "idle" | "checking" | "available" | "taken";

/**
 * Debounced live username-availability check, shared by the register form and
 * the in-app rename. `currentName` (the caller's existing username, if any) is
 * treated as available, so renaming to your own current name never warns.
 * "idle" while empty/unchanged or on a failed check (never asserts "taken" on a
 * network error — the server is the real guard).
 *
 * The displayed status is derived during render (empty/unchanged → idle; a
 * settled result for the current name → its verdict; otherwise → checking), so
 * the effect only ever setState()s from its deferred fetch — not synchronously.
 */
export function useUsernameAvailability(
  name: string,
  currentName?: string | null
): NameAvailability {
  const trimmed = name.trim();
  const unchanged =
    !!currentName && trimmed.toLowerCase() === currentName.trim().toLowerCase();
  const [result, setResult] = useState<{
    q: string;
    status: NameAvailability;
  } | null>(null);

  useEffect(() => {
    if (!trimmed || unchanged) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { available } = await api<{ available: boolean }>(
          `/username-available?name=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        );
        setResult({ q: trimmed, status: available ? "available" : "taken" });
      } catch {
        if (!controller.signal.aborted) setResult({ q: trimmed, status: "idle" });
      }
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed, unchanged]);

  if (!trimmed || unchanged) return "idle";
  if (result && result.q === trimmed) return result.status;
  return "checking";
}
