import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";

// iOS Safari mis-handles Opus-in-Ogg playback (it truncates a track partway and
// auto-skips). The identical Opus bitstream plays correctly once rewrapped in an
// MP4 container, so we losslessly re-mux Opus uploads (and scripts/remux-ogg-to-
// mp4.mjs does the same to the backlog) with `ffmpeg -c:a copy` — no re-encode,
// bit-identical audio.
//
// Best-effort, like loudness/CLAP/art: any failure returns null so the caller
// stores the original file and the upload never fails.

const REMUX_TIMEOUT_MS = 60_000;
// Ogg-family extensions worth probing for Opus; mimeType audio/ogg also triggers.
const OGG_EXTS = new Set(["ogg", "opus", "oga"]);

export type RemuxResult = { body: Buffer; ext: "mp4"; contentType: "audio/mp4" };

/**
 * Losslessly re-mux an Opus-in-Ogg upload to MP4. Returns null when it doesn't
 * apply (not Ogg/Opus) or anything fails — the caller then keeps the original.
 * Before returning, verifies the copied (encoded) audio stream is byte-identical
 * to the source via a decode-free stream hash; that correctly ignores the benign
 * container-level trailing-frame padding MP4 carries vs Ogg (which a decoded-PCM
 * hash would falsely flag).
 */
export async function remuxOpusToMp4(
  buffer: Buffer,
  ext: string,
  mimeType: string
): Promise<RemuxResult | null> {
  if (!OGG_EXTS.has(ext.toLowerCase()) && mimeType !== "audio/ogg") return null;

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-remux-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "ogg";
    const inPath = join(dir, `${randomUUID()}.${safeExt}`);
    const outPath = join(dir, `${randomUUID()}.mp4`);
    await writeFile(inPath, buffer);

    // Only Opus can be copied into MP4 here; Vorbis-in-Ogg (or anything else)
    // can't, so bail and keep the original.
    if ((await audioCodec(inPath)) !== "opus") return null;

    await withFfmpeg(() =>
      runFfmpeg([
        "-i", inPath, "-map", "0:a:0", "-c:a", "copy",
        "-movflags", "+faststart", outPath,
      ])
    );

    const [srcHash, outHash] = await Promise.all([
      streamHash(inPath),
      streamHash(outPath),
    ]);
    if (!srcHash || srcHash !== outHash) return null;

    return { body: await readFile(outPath), ext: "mp4", contentType: "audio/mp4" };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function audioCodec(path: string): Promise<string> {
  const { stdout } = await runFfprobe([
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", path,
  ]);
  return stdout.trim();
}

/** MD5 of the copied (encoded) audio packets — container-agnostic, decode-free. */
async function streamHash(path: string): Promise<string | null> {
  const { stdout } = await runFfmpeg([
    "-i", path, "-map", "0:a:0", "-c:a", "copy",
    "-f", "streamhash", "-hash", "md5", "-",
  ]);
  return stdout.match(/MD5=([0-9a-f]+)/i)?.[1] ?? null;
}

function runFfmpeg(args: string[]): Promise<{ stdout: string }> {
  return capture("ffmpeg", ["-hide_banner", "-nostats", ...args]);
}
function runFfprobe(args: string[]): Promise<{ stdout: string }> {
  return capture("ffprobe", args);
}

function capture(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), REMUX_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-200)}`));
    });
  });
}
