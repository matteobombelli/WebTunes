// One-time / periodic backfill: computes a CLAP audio embedding for every track
// that doesn't have one yet (no track_embeddings row) and writes it, so the
// track can seed and appear in "play similar".
//   node scripts/analyze-clap-embeddings.mjs
// Requires ffmpeg on PATH. DATABASE_URL + S3_* come from the process
// environment when set, otherwise from the first env file present.
//
// IMPORTANT: MODEL_ID, DTYPE and the 48 kHz mono decode below must stay in sync
// with src/lib/clap-embedding.ts — embeddings are only comparable when produced
// by identical model + preprocessing.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];

const MODEL_ID = "Xenova/clap-htsat-unfused";
const DTYPE = "fp32";

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      })
  );
}

function loadEnv() {
  // Start from the ambient env, then overlay every env file that exists in
  // ENV_FILES order so later files (.env.local) win.
  let env = { ...process.env };
  for (const f of ENV_FILES) {
    const path = join(root, f);
    if (existsSync(path)) env = { ...env, ...parseEnvFile(path) };
  }
  return env;
}

const env = loadEnv();

// Client construction must mirror src/lib/s3.ts exactly (see apply-s3-cors.mjs).
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});
const BUCKET = env.S3_BUCKET;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// --- CLAP model (loaded once) ---

let modelPromise = null;
function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { env: tEnv, AutoProcessor, ClapAudioModelWithProjection } =
        await import("@huggingface/transformers");
      tEnv.cacheDir = join(root, ".transformers-cache");
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID),
        ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { dtype: DTYPE }),
      ]);
      return { processor, model };
    })();
  }
  return modelPromise;
}

function runFfmpegDecode(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", inputPath, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function decodeToPcm(buffer, ext) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-clap-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const raw = await runFfmpegDecode(file);
    const n = Math.floor(raw.length / 4);
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function embed(buffer, ext) {
  const pcm = await decodeToPcm(buffer, ext);
  if (pcm.length === 0) return null;
  const { processor, model } = await getModel();
  const inputs = await processor(pcm);
  const { audio_embeds } = await model(inputs);
  const vec = Array.from(audio_embeds.data);
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? vec.map((x) => x / norm) : vec;
}

// A hard wall-clock cap that settles even if the inner promise never does
// (mirrors analyze-loudness.mjs).
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

async function fetchAndEmbed(s3_key, signal) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }), {
    abortSignal: signal,
  });
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  const ext = s3_key.split(".").pop() ?? "bin";
  return embed(buffer, ext);
}

// Load (and download on first run) the model up front so the per-track timeout
// below never has to absorb a slow one-time weight download.
console.log("Loading CLAP model…");
await getModel();

const { rows } = await pool.query(
  `select t.id, t.s3_key
     from tracks t
     left join track_embeddings e on e.track_id = t.id
    where e.track_id is null
    order by t.created_at`
);
console.log(`${rows.length} track(s) to embed.`);

let done = 0;
let failed = 0;
for (const { id, s3_key } of rows) {
  try {
    const controller = new AbortController();
    const vec = await withTimeout(
      fetchAndEmbed(s3_key, controller.signal),
      120_000,
      () => controller.abort()
    );
    if (vec === null) {
      failed++;
      console.warn(`  ${id} — unembeddable (decode error), leaving unembedded`);
      continue;
    }
    await pool.query(
      `insert into track_embeddings (track_id, embedding) values ($1, $2)
       on conflict (track_id) do nothing`,
      // pgvector text literal: '[a,b,c]'. node-pg doesn't know the vector type,
      // so format it ourselves (the drizzle insert path in the app uses the
      // vector column type and passes a number[] directly).
      [id, `[${vec.join(",")}]`]
    );
    done++;
    console.log(`  ${id} — embedded (${vec.length}-d)`);
  } catch (err) {
    failed++;
    console.warn(`  ${id} — failed: ${err.message}`);
  }
}

console.log(`Done. ${done} embedded, ${failed} skipped.`);
await pool.end();
