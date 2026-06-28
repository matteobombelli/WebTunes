import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";

// Downscale cover art to a small JPEG thumbnail. List / queue / mini-bar rows
// render art at <=64px but otherwise download the full-resolution cover (often
// 600px+ from iTunes, larger for embedded art) — wasteful on mobile data over a
// long list. Generated with ffmpeg on upload (and backfilled), stored alongside
// the full art under a sibling key.
//
// Best-effort, exactly like loudness/CLAP/art: any failure returns null and the
// caller falls back to serving the full image, so a missing thumb never breaks
// a row and never fails an upload.

const THUMB_TIMEOUT_MS = 15_000;
const THUMB_PX = 256; // longest edge; covers <=64px boxes even at high DPR

// We always re-encode to JPEG, so the stored Content-Type is ours and is never
// echoed from the untrusted source art (same stored-XSS reasoning as
// lib/image-upload.ts). Thumbs live next to the full art at `.thumb.jpg`.
export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
export const THUMBNAIL_EXT = "thumb.jpg";

/** S3 key for a track's cover thumbnail (sibling of the `art/{owner}/{id}.ext`
 *  full-art key). Deterministic so replacing art overwrites the same object. */
export function thumbnailS3Key(ownerId: string, trackId: string): string {
  return `art/${ownerId}/${trackId}.${THUMBNAIL_EXT}`;
}

/**
 * Make a downscaled JPEG thumbnail (<= 256px longest edge) from cover-art bytes.
 * Returns null on any failure (ffmpeg missing, undecodable image, timeout).
 * @param buffer the source cover-art bytes (jpg/png/webp/gif)
 * @param ext    the source extension; only used to name the temp input file.
 */
export async function makeThumbnail(
  buffer: Buffer,
  ext: string
): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-thumb-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "img";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const out = await withFfmpeg(() => runFfmpeg(file));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        // Fit within THUMB_PX x THUMB_PX, preserving aspect (never upscale-pad).
        "-vf",
        `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1", // first frame only (animated GIF/WebP)
        "-q:v",
        "3",
        "-f",
        "mjpeg",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));

    const timer = setTimeout(() => proc.kill("SIGKILL"), THUMB_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg thumbnail exited ${code}`));
    });
  });
}
