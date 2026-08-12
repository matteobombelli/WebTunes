// Isomorphic logger: warn/error always emit; info/debug require `wt-log=1` in
// localStorage or `WT_VERBOSE=1` on the server. Callers must redact secrets.

type LogLevel = "debug" | "info" | "warn" | "error";

const BUFFER_CAP = 500;

function verbose(): boolean {
  if (typeof window === "undefined") return process.env.WT_VERBOSE === "1";
  try {
    return localStorage.getItem("wt-log") === "1";
  } catch {
    // localStorage unavailable (private mode) - stay quiet.
    return false;
  }
}

// Chrome hides console.debug by default, so debug intentionally uses console.log.
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
