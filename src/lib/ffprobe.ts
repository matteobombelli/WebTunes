import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";
import { log } from "@/lib/log";

// Measure a track's true duration with ffprobe, reading the container's format
// duration. This is the authoritative length of the exact bytes we store/serve -
// unlike music-metadata's value, which is measured on the ORIGINAL upload buffer
// and can diverge from the remuxed MP4 that actually plays (Ogg/WebM-Opus granule
// vs MP4 edit-list; approximate WebM container durations; header-less VBR MP3).
// Measuring the stored bytes makes the listed time equal the played time.
//
// Best-effort, like loudness: any failure (ffprobe missing, unparseable audio,
// timeout) yields null so the caller can fall back to the music-metadata value.

const PROBE_TIMEOUT_MS = 30_000;

/**
 * @param buffer the exact stored audio bytes
 * @param ext    the file extension (used only to name the temp file so ffprobe
 *               can pick the right demuxer; e.g. "mp4", "mp3", "flac")
 * @returns duration in whole seconds (rounded), or null if it can't be measured.
 */
export async function probeDurationSec(
  buffer: Buffer,
  ext: string
): Promise<number | null> {
  // A real file (not stdin): mp4/m4a/webm carry their index in a trailing atom
  // and require a seekable input, which a pipe is not.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-ffprobe-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);

    const stdout = await withFfmpeg(() => runFfprobe(file));
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  } catch (err) {
    log.warn(
      "ffprobe",
      `duration probe failed (.${ext})`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfprobe(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        inputPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // e.g. ffprobe not installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-200)}`));
    });
  });
}
