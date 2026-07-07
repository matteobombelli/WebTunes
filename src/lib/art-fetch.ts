import { spawn } from "child_process";
import { isIP } from "net";
import { withFfmpeg } from "@/lib/ffmpeg-gate";
import { imageKindFromBytes } from "@/lib/image-upload";
import { log } from "@/lib/log";
import type { CoverArt } from "@/lib/metadata-lookup";

// Fetch cover art from a URL the client supplied (the extension importer sends
// Spotify/Apple artwork, or a YouTube thumbnail). Best-effort: null on any
// failure, so the caller falls back to embedded art / recognition and the
// upload never fails on a bad art URL.
//
// SECURITY: the URL and its bytes are untrusted. The stored kind is sniffed
// from the bytes (imageKindFromBytes), never the URL or response Content-Type —
// the offline SW replays stored Content-Type from a same-origin cache
// (stored-XSS), same rule as lib/metadata-lookup.ts and lib/image-upload.ts.

export type { CoverArt };

const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;
const CROP_TIMEOUT_MS = 15_000;
const USER_AGENT = "WebTunes/0.1 (personal project)";

/**
 * SSRF guard: this is the one outbound fetch whose URL a client controls, so
 * require a public-web-shaped https URL — no IP literals, localhost, or
 * internal-suffix hosts (blocks loopback/LAN/cloud-metadata targets). Not
 * DNS-rebinding-proof, but with redirects disabled below it closes the doors
 * an art URL has no business opening.
 */
function isAllowedArtUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  return host.includes(".");
}

/**
 * Download cover art from `url`. When `cropSquare` is set (YouTube's 16:9
 * thumbnails), center-crop to a square first — mirrors the reference
 * exporter's `_fetch_art(crop_square=True)`. Returns null on any failure.
 */
export async function fetchCoverArt(
  url: string,
  opts?: { cropSquare?: boolean }
): Promise<CoverArt | null> {
  if (!isAllowedArtUrl(url)) return null;
  let buf: Buffer;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      // A redirect could bounce the vetted URL to a private target — refuse
      // (throws, caught below). Importer art URLs are direct CDN links.
      redirect: "error",
    });
    if (!res.ok) return null;
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_ART_BYTES) return null;

  if (opts?.cropSquare) {
    const cropped = await centerCropSquare(buf).catch(() => null);
    if (cropped) buf = cropped;
    // A crop failure just keeps the original 16:9 image — never fatal.
  }

  const kind = imageKindFromBytes(buf); // never trust the remote type
  return kind ? { body: buf, kind } : null;
}

/** Center-crop an image to a square via ffmpeg, re-encoded as JPEG. */
function centerCropSquare(buffer: Buffer): Promise<Buffer> {
  return withFfmpeg(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const proc = spawn(
          "ffmpeg",
          [
            "-hide_banner", "-nostats",
            "-i", "pipe:0",
            "-vf", "crop='min(iw,ih)':'min(iw,ih)'",
            "-frames:v", "1",
            "-f", "mjpeg", "pipe:1",
          ],
          { stdio: ["pipe", "pipe", "ignore"] }
        );
        const chunks: Buffer[] = [];
        proc.stdout.on("data", (c: Buffer) => chunks.push(c));
        const timer = setTimeout(() => proc.kill("SIGKILL"), CROP_TIMEOUT_MS);
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
          else reject(new Error(`ffmpeg crop exited ${code}`));
        });
        proc.stdin.on("error", () => {}); // ignore EPIPE if ffmpeg bailed early
        proc.stdin.end(buffer);
      })
  ).catch((err) => {
    log.warn("art-fetch", "square crop failed", err instanceof Error ? err.message : String(err));
    throw err;
  });
}
