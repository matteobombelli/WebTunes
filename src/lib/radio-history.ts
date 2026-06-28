"use client";

// Persistent, bounded memory of recently "play similar"-served track ids, so
// restarting the radio doesn't replay the same neighbourhood. The session-only
// `similarSeen` in the player store is pre-seeded from this on radio start;
// every served batch is appended here. localStorage (not the DB) mirrors the
// other client-persisted player state (wt-player-session, use-persisted-scope).
const RADIO_HISTORY_KEY = "wt-radio-history";

// Newest-N ring buffer. Far under the route's excludeIds.max(10_000) cap, and a
// few-hundred-element NOT IN is cheap. The one knob: too large relative to the
// library starves refills (radio exhausts early, queue plays out).
export const RADIO_HISTORY_MAX = 500;

export function loadRadioHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RADIO_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function pushRadioHistory(ids: string[]): void {
  if (typeof window === "undefined" || ids.length === 0) return;
  // Append, then de-dupe keeping the most-recent occurrence (drop earlier ones),
  // then FIFO-trim to the newest RADIO_HISTORY_MAX.
  const merged = [...loadRadioHistory(), ...ids];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (let i = merged.length - 1; i >= 0; i--) {
    if (seen.has(merged[i])) continue;
    seen.add(merged[i]);
    deduped.push(merged[i]);
  }
  deduped.reverse();
  const trimmed = deduped.slice(-RADIO_HISTORY_MAX);
  try {
    localStorage.setItem(RADIO_HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota / disabled storage — history is best-effort.
  }
}
