// Backfill: re-measure track duration from the EXACT stored bytes with ffprobe
// and correct rows whose stored duration_sec was measured on a different
// container than what actually plays. This mainly affects Opus uploads whose
// duration came from music-metadata reading the original Ogg/WebM buffer while
// the served file is the remuxed MP4 (see src/lib/ffprobe.ts); it also fills
// tracks with a NULL duration.
//
//   node scripts/fix-track-durations.mjs           # dry-run -> review JSONL
//   node scripts/fix-track-durations.mjs --apply    # write + revert log
//
// Requires ffprobe on PATH. DATABASE_URL + S3_* come from the process
// environment when set, otherwise from the first env file present.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];
const APPLY = process.argv.includes("--apply");
// Only correct rows that differ by more than this many seconds (rounding noise
// and sub-second container padding aren't real "listed vs actual" mismatches).
const TOLERANCE_SEC = 1;
const REVIEW_LOG = join(root, "fix-track-durations-review.jsonl");
const REVERT_LOG = join(root, "fix-track-durations-revert.jsonl");

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

function runFfprobe(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        inputPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-200)}`));
    });
  });
}

async function probe(buffer, ext) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-ffprobe-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const seconds = Number((await runFfprobe(file)).trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A hard wall-clock cap that settles even if the inner promise never does (see
// analyze-loudness.mjs for the dead-socket rationale).
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

async function fetchAndProbe(s3_key, signal) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }), {
    abortSignal: signal,
  });
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  const ext = s3_key.split(".").pop() ?? "bin";
  return probe(buffer, ext);
}

const { rows } = await pool.query(
  `select id, s3_key, title, duration_sec from tracks order by created_at`
);
console.log(
  `${rows.length} track(s) to check. Mode: ${APPLY ? "APPLY" : "dry-run"} (tolerance ${TOLERANCE_SEC}s).`
);

let mismatched = 0;
let updated = 0;
let failed = 0;
for (const { id, s3_key, title, duration_sec } of rows) {
  try {
    const controller = new AbortController();
    const actual = await withTimeout(
      fetchAndProbe(s3_key, controller.signal),
      90_000,
      () => controller.abort()
    );
    if (actual === null) {
      failed++;
      console.warn(`  ${id} - unmeasurable, leaving as-is`);
      continue;
    }
    const listed = duration_sec; // may be null
    const diff = listed === null ? null : actual - listed;
    const needsFix = listed === null || Math.abs(diff) > TOLERANCE_SEC;
    if (!needsFix) continue;

    mismatched++;
    const record = { id, title, listed, actual, diff, s3_key };
    appendFileSync(REVIEW_LOG, JSON.stringify(record) + "\n");
    console.log(
      `  ${id} - listed ${listed ?? "NULL"}s -> actual ${actual}s${diff === null ? "" : ` (${diff > 0 ? "+" : ""}${diff}s)`} - ${title}`
    );

    if (APPLY) {
      appendFileSync(REVERT_LOG, JSON.stringify({ id, duration_sec: listed }) + "\n");
      await pool.query(`update tracks set duration_sec = $1 where id = $2`, [actual, id]);
      updated++;
    }
  } catch (err) {
    failed++;
    console.warn(`  ${id} - failed: ${err.message}`);
  }
}

console.log(
  APPLY
    ? `Done. ${mismatched} mismatched, ${updated} updated, ${failed} skipped. Revert log: ${REVERT_LOG}`
    : `Done (dry-run). ${mismatched} mismatched, ${failed} skipped. Review: ${REVIEW_LOG} - re-run with --apply to write.`
);
await pool.end();
