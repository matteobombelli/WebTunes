import { cpus } from "os";

// Caps concurrent ffmpeg subprocesses across the whole Node process. The upload
// pipeline runs its ffmpeg-backed steps (loudness measurement, CLAP PCM decode,
// Opus->MP4 re-mux) in parallel now, and several uploads can land at once;
// without a cap that fans out into unbounded native processes that spike CPU/RAM
// on the single-process VPS. Sized to leave a core for the event loop.
const MAX_FFMPEG = Math.max(2, (cpus().length || 2) - 1);

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  while (active >= MAX_FFMPEG) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
}

function release(): void {
  active--;
  waiters.shift()?.();
}

/** Run `fn` holding one ffmpeg slot; the slot is released even if `fn` throws. */
export async function withFfmpeg<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
