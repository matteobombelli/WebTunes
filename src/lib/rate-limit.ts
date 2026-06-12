// Minimal fixed-window in-memory rate limiter for the unauthenticated auth
// endpoints (login brute force, reset-email flooding). In-memory is enough
// because the app runs as a single Node process (systemd `next start`);
// state lost on restart only ever lets callers retry sooner.

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** Counts a call against `key`; false once more than `limit` calls landed in the current window. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (windows.size > 10_000) {
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function clearRateLimit(key: string) {
  windows.delete(key);
}
