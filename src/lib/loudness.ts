import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";

// Measure a track's integrated loudness (EBU R128, in LUFS) with ffmpeg's
// ebur128 filter. Used to normalize playback volume across tracks.
//
// Best-effort, exactly like cover-art and lyrics extraction: any failure
// (ffmpeg missing, unparseable audio, silence, timeout) yields null so the
// caller can store NULL and skip normalization for that track — it must never
// fail an upload.

const ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * @param buffer the raw audio file bytes
 * @param ext    the file extension (used only to name the temp file so ffmpeg
 *               can pick the right demuxer; e.g. "mp3", "m4a", "flac")
 * @returns integrated loudness in LUFS (negative), or null if it can't be
 *          measured.
 */
export async function analyzeLoudnessLufs(
  buffer: Buffer,
  ext: string
): Promise<number | null> {
  // A real file (not stdin): m4a/mp4/webm carry their index in a trailing
  // atom and require a seekable input, which a pipe is not.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-loudness-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);

    const stderr = await withFfmpeg(() => runFfmpeg(file));
    return parseIntegratedLufs(stderr);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", inputPath, "-af", "ebur128", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => proc.kill("SIGKILL"), ANALYSIS_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // e.g. ffmpeg not installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// ebur128 prints "I:  -16.3 LUFS" on every progress line and once more in the
// final "Summary"; the last numeric match is the final integrated value.
// Silence reports "I: -inf LUFS", which the number pattern skips → null.
function parseIntegratedLufs(stderr: string): number | null {
  const matches = stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
  let last: number | null = null;
  for (const m of matches) last = Number(m[1]);
  return last !== null && Number.isFinite(last) ? last : null;
}
