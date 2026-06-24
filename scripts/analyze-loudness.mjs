// One-time backfill: measures integrated loudness (EBU R128, LUFS) for tracks
// uploaded before volume normalization existed (loudness_lufs IS NULL) and
// writes it back, so playback can attenuate them toward a common target.
//   node scripts/analyze-loudness.mjs
// Requires ffmpeg on PATH. DATABASE_URL + S3_* come from the process
// environment when set, otherwise from the first env file present.
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
  // ENV_FILES order so later files (.env.local) win — and so a value present
  // in any file overrides an empty shell-exported one (e.g. DATABASE_URL="").
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

function parseIntegratedLufs(stderr) {
  const matches = stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
  let last = null;
  for (const m of matches) last = Number(m[1]);
  return last !== null && Number.isFinite(last) ? last : null;
}

function runFfmpeg(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", inputPath, "-af", "ebur128", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function analyze(buffer, ext) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-loudness-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    return parseIntegratedLufs(await runFfmpeg(file));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const { rows } = await pool.query(
  `select id, s3_key from tracks where loudness_lufs is null order by created_at`
);
console.log(`${rows.length} track(s) to analyze.`);

let done = 0;
let failed = 0;
for (const { id, s3_key } of rows) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }));
    const buffer = Buffer.from(await obj.Body.transformToByteArray());
    const ext = s3_key.split(".").pop() ?? "bin";
    const lufs = await analyze(buffer, ext);
    if (lufs === null) {
      failed++;
      console.warn(`  ${id} — unmeasurable (silence/decode error), leaving NULL`);
      continue;
    }
    await pool.query(`update tracks set loudness_lufs = $1 where id = $2`, [lufs, id]);
    done++;
    console.log(`  ${id} — ${lufs.toFixed(1)} LUFS`);
  } catch (err) {
    failed++;
    console.warn(`  ${id} — failed: ${err.message}`);
  }
}

console.log(`Done. ${done} updated, ${failed} skipped.`);
await pool.end();
