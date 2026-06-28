// One-time backfill: generates downscaled JPEG cover thumbnails for tracks that
// have full art (art_s3_key) but no thumbnail yet (art_thumb_s3_key IS NULL),
// so list/queue/mini-bar rows stop pulling the full-resolution cover. Mirrors
// src/lib/thumbnail.ts — keep the ffmpeg args, size, and key scheme in sync.
//   node scripts/backfill-thumbnails.mjs
// Requires ffmpeg on PATH. DATABASE_URL + S3_* come from the process environment
// when set, otherwise from the first env file present.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];

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

const THUMB_PX = 256; // longest edge — must match src/lib/thumbnail.ts
const THUMB_CONTENT_TYPE = "image/jpeg";

function runFfmpeg(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        "-vf",
        `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-f",
        "mjpeg",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function makeThumbnail(buffer, ext) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-thumb-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "img";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const out = await runFfmpeg(file);
    return out.length > 0 ? out : null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Hard wall-clock cap so a dead socket mid-stream-read can't wedge the backfill.
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

async function fetchArt(s3_key, signal) {
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }),
    { abortSignal: signal }
  );
  return Buffer.from(await obj.Body.transformToByteArray());
}

const { rows } = await pool.query(
  `select id, owner_id, art_s3_key from tracks
   where art_s3_key is not null and art_thumb_s3_key is null
   order by created_at`
);
console.log(`${rows.length} track(s) need thumbnails.`);

let done = 0;
let failed = 0;
for (const { id, owner_id, art_s3_key } of rows) {
  try {
    const controller = new AbortController();
    const art = await withTimeout(
      fetchArt(art_s3_key, controller.signal),
      60_000,
      () => controller.abort()
    );
    const ext = art_s3_key.split(".").pop() ?? "jpg";
    const thumb = await makeThumbnail(art, ext);
    if (!thumb) {
      failed++;
      console.warn(`  ${id} — thumbnail failed, leaving NULL`);
      continue;
    }
    // Deterministic sibling key — must match thumbnailS3Key() in lib/thumbnail.ts.
    const thumbKey = `art/${owner_id}/${id}.thumb.jpg`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbKey,
        Body: thumb,
        ContentType: THUMB_CONTENT_TYPE,
      })
    );
    await pool.query(`update tracks set art_thumb_s3_key = $1 where id = $2`, [
      thumbKey,
      id,
    ]);
    done++;
    console.log(`  ${id} — ${(thumb.length / 1024).toFixed(0)}KB thumb`);
  } catch (err) {
    failed++;
    console.warn(`  ${id} — failed: ${err.message}`);
  }
}

console.log(`Done. ${done} updated, ${failed} skipped.`);
await pool.end();
