const AUDIO_LOG_KEY = "wt-audio-log";
const BUFFER_CAP = 200;

/** Persistent, opt-in diagnostics for iOS audio failures that survive page discard. */
export function logAudio(event: string, detail?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem("wt-audio-debug") !== "1") return;
  } catch {
    return;
  }

  const line = `${new Date().toISOString().slice(11, 23)} [wt-audio] ${event}${
    detail ? ` ${detail}` : ""
  }`;
  console.info(line);

  const debugWindow = window as unknown as { __wtAudioLog?: string[] };
  const memoryLog = (debugWindow.__wtAudioLog ??= []);
  memoryLog.push(line);
  if (memoryLog.length > BUFFER_CAP) memoryLog.shift();

  try {
    const persisted = JSON.parse(
      localStorage.getItem(AUDIO_LOG_KEY) ?? "[]"
    ) as string[];
    persisted.push(line);
    while (persisted.length > BUFFER_CAP) persisted.shift();
    localStorage.setItem(AUDIO_LOG_KEY, JSON.stringify(persisted));
  } catch {
    // The in-memory log remains available when storage is full or unavailable.
  }
}
