"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Scope = "own" | "all" | "friends";

const isScope = (v: unknown): v is Scope =>
  v === "own" || v === "all" || v === "friends";

/**
 * Scope selection (own/all/friends) backed by localStorage under `key`.
 * Server and first client render both report "own" (so hydration matches),
 * then the saved value is read once mounted. The setter writes through and
 * dispatches a storage event so this tab (and others) re-read immediately.
 */
export function usePersistedScope(key: string): [Scope, (s: Scope) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);

  const getSnapshot = useCallback((): Scope => {
    const saved = localStorage.getItem(key);
    return isScope(saved) ? saved : "own";
  }, [key]);

  const getServerSnapshot = (): Scope => "own";
  const scope = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setScope = useCallback(
    (s: Scope) => {
      localStorage.setItem(key, s);
      window.dispatchEvent(new StorageEvent("storage", { key }));
    },
    [key]
  );

  return [scope, setScope];
}
