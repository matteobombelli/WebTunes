import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ingestTrack, MAX_FILE_BYTES } from "@/lib/ingest";
import {
  DEFAULT_STRICTNESS,
  findMatch,
  MIN_SOURCE_KBPS,
} from "@/lib/import/match";
import {
  appleMusicTracks,
  classifyUrl,
  spotifyTracks,
  type SourceKind,
  type SourceTrack,
} from "@/lib/import/sources";
import { downloadAudio, flatExtract, probeVideo } from "@/lib/import/ytdlp";
import { log } from "@/lib/log";
import type {
  ImportItemDTO,
  ImportJobDTO,
  ImportJobStatus,
  ImportQuality,
  ImportVersionPref,
} from "@/lib/types";

// Server-side import jobs: resolve a pasted URL (YouTube video/playlist, or a
// Spotify/Apple list matched to YouTube) into tracks via yt-dlp and feed each
// one through ingestTrack — the same pipeline as a web upload. In-process
// registry like the CLAP/recognition queues: a mid-deploy restart loses only
// the in-flight job, and re-pasting the link is cheap because ingest's sha256
// dedupe turns everything already imported into instant duplicates.
//
// ONE global worker (not per-user): every download leaves this box's single
// IP, and YouTube rate-limits aggressively — same politeness rationale as
// recognize-queue. Per-user fairness comes from the one-active-job-per-user
// guard instead.

export type ImportOptions = {
  quality: ImportQuality;
  strictness: number;
  versionPref: ImportVersionPref;
};

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  quality: "opus",
  strictness: DEFAULT_STRICTNESS,
  versionPref: "none",
};

type Item = ImportItemDTO & {
  /** YouTube path: the video to download directly. */
  videoUrl: string | null;
  /** Matched path: the Spotify/Apple metadata to resolve via search. */
  track: SourceTrack | null;
};

type Job = {
  id: string;
  userId: string;
  sourceUrl: string;
  kind: SourceKind;
  status: ImportJobStatus;
  error: string | null;
  items: Item[];
  log: string[];
  opts: ImportOptions;
  createdAt: Date;
  finishedAt: Date | null;
  abort: AbortController;
};

const MAX_PLAYLIST_TRACKS = 500;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_LOG_LINES = 2000; // like the desktop log view's block cap

/** Append to the job's user-facing log (the Import dialog's log view). */
function jobLog(job: Job, message: string): void {
  job.log.push(message);
  if (job.log.length > MAX_LOG_LINES) job.log.shift();
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let workerRunning = false;

function isActive(job: Job): boolean {
  return job.status === "resolving" || job.status === "running";
}

/** Drop finished jobs after an hour — checked lazily, no timer. */
function prune(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt.getTime() < cutoff) jobs.delete(id);
  }
}

function toDTO(job: Job): ImportJobDTO {
  return {
    id: job.id,
    sourceUrl: job.sourceUrl,
    kind: job.kind,
    status: job.status,
    error: job.error,
    items: job.items.map(({ label, status, progress, reason }) => ({
      label,
      status,
      progress,
      reason,
    })),
    log: job.log,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function startImport(
  userId: string,
  url: string,
  opts: ImportOptions
): { ok: true; jobId: string } | { ok: false; error: string } {
  prune();
  const kind = classifyUrl(url);
  if (!kind) {
    return { ok: false, error: "Enter a YouTube, Spotify, or Apple Music URL" };
  }
  for (const job of jobs.values()) {
    if (job.userId === userId && isActive(job)) {
      return { ok: false, error: "An import is already running" };
    }
  }
  const job: Job = {
    id: crypto.randomUUID(),
    userId,
    sourceUrl: url,
    kind,
    status: "resolving",
    error: null,
    items: [],
    log: [],
    opts,
    createdAt: new Date(),
    finishedAt: null,
    abort: new AbortController(),
  };
  jobs.set(job.id, job);
  queue.push(job);
  if (!workerRunning) {
    workerRunning = true;
    void runWorker();
  }
  return { ok: true, jobId: job.id };
}

export function listJobs(userId: string): ImportJobDTO[] {
  prune();
  return [...jobs.values()]
    .filter((j) => j.userId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toDTO);
}

export function cancelJob(userId: string, jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return false;
  if (!isActive(job)) return true; // already terminal — cancel is a no-op
  job.abort.abort();
  // Mark immediately so the next poll reflects the cancel; the worker's own
  // finalization writes the same values (idempotent).
  finalizeCancelled(job);
  log.info("import", `cancelled job ${job.id}`);
  return true;
}

function finalizeCancelled(job: Job): void {
  for (const item of job.items) {
    if (
      item.status === "waiting" ||
      item.status === "matching" ||
      item.status === "downloading" ||
      item.status === "uploading"
    ) {
      item.status = "cancelled";
    }
  }
  job.status = "cancelled";
  job.finishedAt ??= new Date();
}

async function runWorker(): Promise<void> {
  try {
    let job: Job | undefined;
    while ((job = queue.shift())) {
      if (job.abort.signal.aborted) continue; // cancelled while queued
      await runJob(job).catch((err) => {
        // runJob handles its own errors; this is a belt-and-braces backstop so
        // one broken job can never wedge the singleton worker.
        log.warn(
          "import",
          `job crashed ${job?.id}`,
          err instanceof Error ? err.message : String(err)
        );
      });
    }
  } finally {
    workerRunning = false;
  }
}

/** Sleep that rejects on abort so a cancel doesn't wait out a 429 cooldown. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry a yt-dlp call after a cooldown on YouTube 429 rate-limits. Anything
 * else — including a 403 — propagates to the caller, which records the miss
 * and moves on. */
async function withRetry<T>(
  fn: () => Promise<T>,
  job: Job
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : "";
      const rateLimited =
        message.includes("429") || message.includes("too many requests");
      if (!rateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      jobLog(
        job,
        `YouTube rate-limiting (HTTP 429). Pausing ${RATE_LIMIT_COOLDOWN_MS / 1000}s, then retrying…`
      );
      log.info("import", `YouTube 429 — cooling down ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
      await sleep(RATE_LIMIT_COOLDOWN_MS, job.abort.signal);
      jobLog(job, "Cooldown over — resuming.");
    }
  }
}

async function runJob(job: Job): Promise<void> {
  const signal = job.abort.signal;
  try {
    job.items = await resolveItems(job);
    if (job.items.length === 0) {
      job.status = "error";
      job.error = "Nothing to import behind that link";
      return;
    }
    if (job.items.length > MAX_PLAYLIST_TRACKS) {
      job.status = "error";
      job.error = `Playlist has ${job.items.length} tracks — the limit is ${MAX_PLAYLIST_TRACKS}`;
      return;
    }
    job.status = "running";
    jobLog(
      job,
      `Found ${job.items.length} ${job.kind === "youtube" ? "video" : "track"}(s). Importing…`
    );
    log.info("import", `job ${job.id}: ${job.items.length} item(s) from ${job.kind}`);

    let i = 0;
    for (const item of job.items) {
      i++;
      if (signal.aborted) break;
      try {
        await runItem(job, item, `[${i}/${job.items.length}]`);
      } catch (err) {
        if (signal.aborted) {
          item.status = "cancelled";
          break;
        }
        item.status = "missed";
        item.reason = err instanceof Error ? err.message : String(err);
        jobLog(job, `[${i}/${job.items.length}] Missed: ${item.label} (${item.reason})`);
        log.info("import", `missed: ${item.label}`, item.reason);
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      jobLog(job, `Error: ${job.error}`);
      log.warn("import", `job failed ${job.id}`, job.error);
    }
  } finally {
    if (signal.aborted) {
      finalizeCancelled(job);
      jobLog(job, summaryLine(job, "Cancelled"));
    } else if (job.status === "running") {
      job.status = "done";
      jobLog(job, summaryLine(job, "Done"));
      const done = job.items.filter((it) => it.status === "done").length;
      const missed = job.items.filter((it) => it.status === "missed").length;
      log.info(
        "import",
        `job ${job.id} done: ${done} imported, ${missed} missed of ${job.items.length}`
      );
    }
    job.finishedAt ??= new Date();
  }
}

function summaryLine(job: Job, prefix: string): string {
  const done = job.items.filter((it) => it.status === "done").length;
  const missed = job.items.filter((it) => it.status === "missed").length;
  const duplicates = job.items.filter((it) => it.status === "duplicate").length;
  const parts = [`${done} imported`, `${missed} missed`];
  if (duplicates) parts.push(`${duplicates} already in WebTunes`);
  return `${prefix}: ${parts.join(", ")} (of ${job.items.length}).`;
}

async function resolveItems(job: Job): Promise<Item[]> {
  const signal = job.abort.signal;
  const base = { status: "waiting" as const, progress: 0, reason: null };
  if (job.kind === "youtube") {
    jobLog(job, "Fetching YouTube link…");
    const entries = await withRetry(() => flatExtract(job.sourceUrl, signal), job);
    return entries.map((e) => ({
      ...base,
      label: e.title,
      videoUrl: e.url,
      track: null,
    }));
  }
  jobLog(
    job,
    `Fetching ${job.kind === "spotify" ? "Spotify" : "Apple Music"} metadata…`
  );
  const tracks =
    job.kind === "spotify"
      ? await spotifyTracks(job.sourceUrl)
      : await appleMusicTracks(job.sourceUrl);
  return tracks.map((t) => ({
    ...base,
    label: `${t.artist} - ${t.title}`.replace(/^ - /, ""),
    videoUrl: null,
    track: t,
  }));
}

async function runItem(job: Job, item: Item, tag: string): Promise<void> {
  const signal = job.abort.signal;
  const { quality, strictness, versionPref } = job.opts;

  const miss = (reason: string) => {
    item.status = "missed";
    item.reason = reason;
    jobLog(job, `${tag} Missed: ${item.label} (${reason})`);
  };

  let videoUrl = item.videoUrl;
  let matchNote = "";
  if (!videoUrl) {
    // Matched path: resolve the Spotify/Apple metadata to a YouTube video.
    item.status = "matching";
    const match = await withRetry(
      () => findMatch(item.track!, versionPref, strictness, signal),
      job
    );
    if (match.url === null) {
      miss(match.reason);
      return;
    }
    videoUrl = match.url;
    matchNote = ` (match ${match.score.toFixed(2)})`;
  }

  const info = await withRetry(() => probeVideo(videoUrl, signal), job);
  if (info.bestAudioKbps > 0 && info.bestAudioKbps < MIN_SOURCE_KBPS) {
    miss(
      `source ${Math.round(info.bestAudioKbps)} kbps < ${MIN_SOURCE_KBPS} kbps floor`
    );
    return;
  }

  jobLog(job, `${tag} Importing${matchNote}: ${item.label}`);
  item.status = "downloading";
  const dir = await mkdtemp(join(tmpdir(), "webtunes-import-"));
  try {
    const file = await withRetry(
      () =>
        downloadAudio({
          url: videoUrl,
          quality,
          dir,
          signal,
          onProgress: (percent) => {
            item.progress = percent;
          },
        }),
      job
    );
    // Re-check the app's upload cap on the real file before buffering it.
    const { size } = await stat(file.path);
    if (size > MAX_FILE_BYTES) {
      miss("file exceeds the 100 MB limit");
      return;
    }

    item.status = "uploading";
    item.progress = 100;
    const buffer = await readFile(file.path);
    // Source metadata wins (matched path); the YouTube path tags from the
    // video and square-crops its 16:9 thumbnail — exactly like the desktop
    // importer's extension-import uploads.
    const overrides = item.track
      ? {
          title: item.track.title,
          artist: item.track.artist,
          album: item.track.album,
          artUrl: item.track.artUrl || null,
        }
      : {
          title: info.title,
          artist: info.artist,
          album: info.album,
          artUrl: info.thumbnail,
          artCropSquare: true,
        };
    const result = await ingestTrack({
      userId: job.userId,
      buffer,
      filename: file.filename,
      mimeType: file.mimeType,
      overrides,
    });
    if (result.status === "duplicate") {
      item.status = "duplicate";
      item.reason = result.message;
      jobLog(job, `${tag} Already in WebTunes: ${item.label}`);
    } else {
      item.status = "done";
      log.info("import", `imported ${result.track.id} from ${videoUrl.slice(0, 200)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
