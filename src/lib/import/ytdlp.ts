import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { ImportQuality, ImportSearchResultDTO } from "@/lib/types";

// CLI wrapper around the yt-dlp standalone binary - the only file that spawns
// it. yt-dlp is a runtime dependency like ffmpeg/fpcalc, but repo-local
// (bin/yt-dlp, gitignored) because it self-updates in place (`yt-dlp -U`,
// daily deploy/webtunes-ytdlp-update.timer) - YouTube breakage is its #1
// failure mode and a distro package would lag. Its ffmpeg post-processing runs
// outside lib/ffmpeg-gate.ts; acceptable because the import worker (jobs.ts)
// is strictly serial, so at most one yt-dlp ffmpeg runs at a time.

/** One row of a flat playlist/search extraction - enough to list and match.
 * Same shape the search route returns to the client. */
export type FlatEntry = ImportSearchResultDTO;

/** Full probe of one video: import metadata + the bitrate-floor input. */
export type VideoInfo = {
  title: string;
  artist: string;
  album: string;
  thumbnail: string | null;
  /** Best available audio bitrate in kbps, 0 when undeterminable. */
  bestAudioKbps: number;
};

const EXTRACT_TIMEOUT_MS = 5 * 60_000; // a 500-entry flat playlist is paginated
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// --js-runtimes node: yt-dlp's JS challenge solver needs a runtime; the box has
// Node (no deno). --remote-components ejs:github lets it fetch that solver,
// needed for full YouTube format access (mirrors the desktop importer's opts).
const COMMON_ARGS = [
  "--no-warnings",
  "--js-runtimes",
  "node",
  "--remote-components",
  "ejs:github",
];

export function ytdlpPath(): string {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  const local = join(process.cwd(), "bin", "yt-dlp");
  return existsSync(local) ? local : "yt-dlp";
}

function runYtdlp(
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number; onLine?: (line: string) => void }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlpPath(), [...COMMON_ARGS, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!opts.onLine) return;
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onLine(line.trim());
    });
    proc.stderr.on("data", (chunk) => {
      // Keep only a tail: format-listing errors can be pages long.
      stderr = (stderr + chunk).slice(-4000);
    });

    const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      // Spawn failure (binary missing) or abort-signal kill.
      reject(
        err.name === "AbortError" ? new Error("cancelled") : err
      );
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (opts.signal.aborted) reject(new Error("cancelled"));
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function bestThumbnail(entry: {
  thumbnails?: { url?: string; width?: number }[] | null;
  thumbnail?: string | null;
}): string | null {
  const thumbs = entry.thumbnails ?? [];
  let best: { url?: string; width?: number } | null = null;
  for (const t of thumbs) {
    if (!best || (t.width ?? 0) > (best.width ?? 0)) best = t;
  }
  return best?.url ?? entry.thumbnail ?? null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- yt-dlp's JSON is untyped */

/**
 * Flat extraction of a playlist URL, video URL, or "ytsearchN:query" - one
 * entry per video, nothing resolved. `--flat-playlist` is yt-dlp's
 * extract_flat='in_playlist': a watch?v=…&list=… URL still expands into the
 * playlist, while a plain video fully extracts to a single entry.
 */
export async function flatExtract(
  target: string,
  signal: AbortSignal
): Promise<FlatEntry[]> {
  const out = await runYtdlp(["-J", "--flat-playlist", target], {
    signal,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  const info = JSON.parse(out);
  const entries: any[] = "entries" in info ? (info.entries ?? []) : [info];
  return entries
    .filter((e) => e && (e.url || e.webpage_url))
    .map((e) => ({
      id: String(e.id ?? e.url ?? e.webpage_url),
      url: String(e.url ?? e.webpage_url),
      title: String(e.title ?? "(untitled)"),
      uploader: String(e.uploader ?? e.channel ?? ""),
      duration: typeof e.duration === "number" ? e.duration : null,
      thumbnail: bestThumbnail(e),
    }));
}

/**
 * Full extraction of one video: the import metadata (track/artist/album fields
 * when YouTube has them, falling back to title/uploader - same precedence as
 * the desktop importer) plus the best audio bitrate for the kbps floor. One
 * call replaces the desktop's separate probe + in-download metadata extract.
 */
export async function probeVideo(
  url: string,
  signal: AbortSignal
): Promise<VideoInfo> {
  const out = await runYtdlp(["-J", "--no-playlist", url], {
    signal,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  const info = JSON.parse(out);
  let bestAudioKbps = 0;
  for (const f of (info.formats ?? []) as any[]) {
    if (!f?.acodec || f.acodec === "none") continue;
    // Muxed (audio+video) formats report a tbr that includes the video bitrate,
    // which would inflate the floor check - only audio-only formats count.
    if (f.vcodec && f.vcodec !== "none") continue;
    const rate = f.abr ?? f.tbr ?? 0;
    if (rate > bestAudioKbps) bestAudioKbps = rate;
  }
  return {
    title: String(info.track ?? info.title ?? ""),
    artist: String(info.artist ?? info.uploader ?? ""),
    album: String(info.album ?? ""),
    thumbnail: bestThumbnail(info),
    bestAudioKbps,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg", // ingest's remuxOpusToMp4 keys off this ext → iOS-safe MP4
  m4a: "audio/mp4",
  webm: "audio/webm",
};

/**
 * Download one video's audio into the caller-owned dir. Quality mirrors the
 * desktop importer: "128"/"192" transcode to MP3, "opus" repackages YouTube's
 * native Opus stream - or, when the video has none, stream-copies the best
 * audio into its native container instead (still lossless, never re-encoded) -
 * "m4a" copies the native AAC stream (lossless, fails when the video has none
 * rather than re-encoding).
 */
export async function downloadAudio(opts: {
  url: string;
  quality: ImportQuality;
  dir: string;
  signal: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<{ path: string; filename: string; mimeType: string }> {
  const args = [
    "--no-playlist",
    "-o",
    join(opts.dir, "track.%(ext)s"),
    // --print implies simulation; --no-simulate restores the download and makes
    // after_move:filepath print the final (post-processed) file path.
    "--no-simulate",
    "--print",
    "after_move:filepath",
    "--newline",
    "--progress-template",
    "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
  ];
  if (opts.quality === "opus") {
    // No --audio-format: bare -x stream-copies into the codec's native
    // container (opus→.opus, aac→.m4a), so the AAC fallback isn't re-encoded.
    args.push("-f", "bestaudio[acodec=opus]/bestaudio", "-x");
  } else if (opts.quality === "m4a") {
    // AAC-only so the copy is truly lossless (no Opus→AAC re-encode).
    args.push("-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]");
  } else {
    args.push(
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      `${opts.quality}K`
    );
  }
  args.push(opts.url);

  let filepath: string | null = null;
  try {
    await runYtdlp(args, {
      signal: opts.signal,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onLine: (line) => {
        if (line.startsWith("PROGRESS ")) {
          const [downloaded, total] = line.slice("PROGRESS ".length).split(" ");
          const totalNum = Number(total);
          if (opts.onProgress && totalNum > 0) {
            opts.onProgress(
              Math.min(100, Math.round((Number(downloaded) * 100) / totalNum))
            );
          }
        } else {
          filepath = line; // after_move:filepath - the last non-progress line
        }
      },
    });
  } catch (err) {
    // Only the format-selection failure means "no AAC stream" - anything else
    // (unavailable video, exhausted 429 retries) keeps its real message.
    if (
      opts.quality === "m4a" &&
      err instanceof Error &&
      err.message.includes("Requested format is not available")
    ) {
      throw new Error(
        "no lossless .m4a (AAC) stream available - try Best (Opus) instead",
        { cause: err }
      );
    }
    throw err;
  }
  if (!filepath) throw new Error("download produced no file");
  const path: string = filepath;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return {
    path,
    filename: `track.${ext}`,
    mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
  };
}
