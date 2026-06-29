import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";
import { log } from "@/lib/log";

// Encode a track's audio into a CLAP embedding for similarity search ("play
// similar"). We decode to PCM with the same ffmpeg we already depend on for
// loudness, then run the CLAP audio encoder (HTSAT) in-process via
// @huggingface/transformers (ONNX).
//
// Best-effort, exactly like loudness/art/lyrics: any failure (ffmpeg missing,
// model load failure, unparseable audio, timeout) yields null so the caller
// stores no embedding for that track — it must never fail an upload.
//
// IMPORTANT: MODEL_ID, DTYPE and the 48 kHz mono decode below must stay in sync
// with scripts/analyze-clap-embeddings.mjs — embeddings are only comparable
// when produced by identical model + preprocessing.

// Model + dtype. clap-htsat-unfused's audio projection is 512-d. fp32 (the
// default weights) is used for embedding quality; the VPS has the RAM headroom.
const MODEL_ID = "Xenova/clap-htsat-unfused";
const DTYPE = "fp32" as const;
// Persistent, repo-local weights cache so uploads never re-download from
// HuggingFace at request time (survives `npm install`, unlike node_modules).
const CACHE_DIR = join(process.cwd(), ".transformers-cache");

const DECODE_TIMEOUT_MS = 30_000;
// Bound the decoded PCM so a crafted long / low-bitrate file can't balloon RAM:
// 48 kHz mono f32 is 192 KB/s, so 1 GiB caps ~93 min of audio. The CLAP feature
// extractor only consumes a random 10 s window, so truncating beyond this is
// harmless for real music while it stops a decompression-style OOM. KEEP IN SYNC
// with scripts/analyze-clap-embeddings.mjs.
const MAX_DECODE_BYTES = 1024 * 1024 * 1024;
// CLAP truncates to a fixed window, so inference time is roughly constant; only
// a stuck onnxruntime call needs a backstop.
const MAX_CONCURRENT = 2;

/**
 * @param buffer raw audio file bytes
 * @param ext    file extension, used to name the temp file so ffmpeg picks the
 *               right demuxer (e.g. "mp3", "m4a", "flac")
 * @returns an L2-normalized 512-d embedding (so cosine similarity is a plain
 *          dot product), or null if it can't be computed.
 */
export async function embedTrack(
  buffer: Buffer,
  ext: string
): Promise<number[] | null> {
  try {
    const pcm = await decodeToPcm(buffer, ext);
    if (pcm.length === 0) return null;

    await acquire();
    try {
      const { processor, model } = await getModel();
      const inputs = await processor(pcm);
      const { audio_embeds } = await model(inputs);
      return l2normalize(Array.from(audio_embeds.data as Float32Array));
    } finally {
      release();
    }
  } catch (err) {
    log.warn(
      "clap",
      `embed failed (.${ext})`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? vec.map((x) => x / norm) : vec;
}

// --- CLAP model (loaded once per process, lazily) ---

type ClapModel = {
  // The processor and model are dynamically typed by the transformers package;
  // the shapes we use are processor(pcm) and model(inputs) -> { audio_embeds }.
  processor: (audio: Float32Array) => Promise<unknown>;
  model: (inputs: unknown) => Promise<{ audio_embeds: { data: Float32Array } }>;
};

let modelPromise: Promise<ClapModel> | null = null;

function getModel(): Promise<ClapModel> {
  // On failure, drop the cached promise so a later upload can retry the load
  // (e.g. a transient first-time weight download).
  if (!modelPromise) {
    modelPromise = loadModel().catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

async function loadModel(): Promise<ClapModel> {
  const { env, AutoProcessor, ClapAudioModelWithProjection } = await import(
    "@huggingface/transformers"
  );
  env.cacheDir = CACHE_DIR;
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { dtype: DTYPE }),
  ]);
  return { processor, model } as unknown as ClapModel;
}

// --- ffmpeg decode to 48 kHz mono float PCM ---

async function decodeToPcm(buffer: Buffer, ext: string): Promise<Float32Array> {
  // A real seekable file: m4a/mp4/webm carry their index in a trailing atom,
  // which a pipe can't provide (mirrors lib/loudness.ts).
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-clap-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);

    // Gate the decode (not just the ONNX inference below) so parallel uploads
    // can't stack unbounded ffmpeg decodes and exhaust CPU/RAM.
    const raw = await withFfmpeg(() => runFfmpegDecode(file));
    // .slice copies into a fresh, 4-byte-aligned ArrayBuffer (Buffer.concat's
    // offset isn't guaranteed aligned for a Float32Array view).
    const n = Math.floor(raw.length / 4);
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpegDecode(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // -ac 1 -ar 48000 -f f32le: mono, 48 kHz, raw 32-bit float PCM in [-1,1] —
    // exactly what the CLAP feature extractor expects.
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", inputPath, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    proc.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (!capped && total >= MAX_DECODE_BYTES) {
        // Enough audio for the random window; stop before RAM balloons. The
        // partial buffer is still valid PCM, so we resolve with it below.
        capped = true;
        proc.kill("SIGKILL");
      }
    });

    const timer = setTimeout(() => proc.kill("SIGKILL"), DECODE_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // e.g. ffmpeg not installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (capped || code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// --- concurrency gate: cap simultaneous inferences so the client's bounded
// concurrent-upload pool can't stack model runs and spike CPU/RAM. ---

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
}

function release(): void {
  active--;
  waiters.shift()?.();
}
