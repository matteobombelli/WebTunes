// Isomorphic, namespaced logger for browser-console (F12) + journal visibility.
//
// No "use client" and no env-specific imports, so it is safe to import from both
// "use client" components and server route handlers/libs (same neutrality as
// base-path.ts / api.ts).
//
// Gating: warn/error ALWAYS emit. info/debug emit only when verbose is on —
// client: localStorage["wt-log"] === "1"; server: process.env.WT_VERBOSE === "1".
// (Mirrors the existing logAudio `wt-audio-debug` flag; that logger stays separate
// under the `[wt-audio]` namespace.)
//
// REDACTION: callers must pass only non-sensitive data. Never pass request bodies,
// full response JSON, headers, passwords, or tokens — see api.ts.

export type LogLevel = "debug" | "info" | "warn" | "error";

const BUFFER_CAP = 500;

function verbose(): boolean {
  if (typeof window === "undefined") return process.env.WT_VERBOSE === "1";
  try {
    return localStorage.getItem("wt-log") === "1";
  } catch {
    // localStorage unavailable (private mode) — stay quiet.
    return false;
  }
}

// debug → console.log (NOT console.debug, which Chrome hides behind the "Verbose"
// level filter); the rest map to the matching console method so DevTools colours
// and level-filters work.
const CONSOLE: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function emit(level: LogLevel, ns: string, message: string, detail?: unknown) {
  if ((level === "debug" || level === "info") && !verbose()) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} [wt:${ns}] ${level.toUpperCase()} ${message}`;
  if (detail === undefined) CONSOLE[level](line);
  else CONSOLE[level](line, detail);
  // In-memory ring buffer (client only) so a whole session is copyable from the
  // console via `copy(window.__wtLog.join("\n"))`.
  if (typeof window !== "undefined") {
    const w = window as unknown as { __wtLog?: string[] };
    let tail = "";
    if (detail !== undefined) {
      try {
        tail = " " + JSON.stringify(detail);
      } catch {
        tail = " " + String(detail);
      }
    }
    (w.__wtLog ??= []).push(line + tail);
    if (w.__wtLog.length > BUFFER_CAP) w.__wtLog.shift();
  }
}

export const log = {
  debug: (namespace: string, message: string, detail?: unknown) =>
    emit("debug", namespace, message, detail),
  info: (namespace: string, message: string, detail?: unknown) =>
    emit("info", namespace, message, detail),
  warn: (namespace: string, message: string, detail?: unknown) =>
    emit("warn", namespace, message, detail),
  error: (namespace: string, message: string, detail?: unknown) =>
    emit("error", namespace, message, detail),
};
