// One-time (resumable) backfill: losslessly re-mux Opus-in-Ogg tracks to MP4.
// iOS Safari truncates Opus-in-Ogg playback; the same Opus bitstream plays fully
// in an MP4 container. `ffmpeg -c:a copy` re-wraps without re-encoding, so the
// audio is bit-identical. Verified per file by comparing a decode-free hash of
// the copied (encoded) audio stream before the row is updated.
//
//   node scripts/remux-ogg-to-mp4.mjs [limit]
//
// Touches only mime_type='audio/ogg', so it's resumable (migrated rows become
// audio/mp4 and are skipped on re-run). Originals are KEPT in S3 (reversible);
// each change is appended to remux-revert.jsonl. Requires ffmpeg + ffprobe on
// PATH. DATABASE_URL + S3_* come from the environment or the first env file.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];
const REVERT_LOG = join(root, "remux-revert.jsonl");
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : null;

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

let env = { ...process.env };
for (const f of ENV_FILES) {
  const path = join(root, f);
  if (existsSync(path)) env = { ...env, ...parseEnvFile(path) };
}

// Client construction mirrors src/lib/s3.ts.
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

function run(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
    proc.on("error", (e) => (clearTimeout(timer), resolve({ code: 1, stdout, stderr: stderr + e.message })));
    proc.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
  });
}

async function audioCodec(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", path,
  ]);
  return stdout.trim();
}

// Decode-free hash of the copied (encoded) Opus packets; container-agnostic.
async function streamHash(path) {
  const { stdout } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-c:a", "copy",
    "-f", "streamhash", "-hash", "md5", "-",
  ]);
  return (stdout.match(/MD5=([0-9a-f]+)/i) || [])[1] || null;
}

const { rows } = await pool.query(
  `select id, s3_key, title from tracks where mime_type='audio/ogg' order by created_at` +
    (LIMIT ? ` limit ${LIMIT}` : "")
);
console.log(`${rows.length} audio/ogg track(s) to re-mux -> MP4${LIMIT ? ` (limit ${LIMIT})` : ""}\n`);

let ok = 0;
let skip = 0;
let fail = 0;
for (const { id, s3_key, title } of rows) {
  let dir = null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }));
    const buf = Buffer.from(await obj.Body.transformToByteArray());
    dir = await mkdtemp(join(tmpdir(), "wt-remux-"));
    const inPath = join(dir, `${randomUUID()}.ogg`);
    const outPath = join(dir, `${randomUUID()}.mp4`);
    await writeFile(inPath, buf);

    if ((await audioCodec(inPath)) !== "opus") {
      skip++;
      console.log(`  SKIP  ${title} — not opus (can't -c:a copy into mp4)`);
      continue;
    }

    const remux = await run("ffmpeg", [
      "-hide_banner", "-nostats", "-y", "-i", inPath,
      "-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", outPath,
    ]);
    if (remux.code !== 0 || !existsSync(outPath)) {
      fail++;
      console.log(`  FAIL  ${title} — ffmpeg: ${(remux.stderr.split("\n").filter(Boolean).pop() || "").slice(0, 80)}`);
      continue;
    }

    const [h1, h2] = await Promise.all([streamHash(inPath), streamHash(outPath)]);
    if (!h1 || h1 !== h2) {
      fail++;
      console.log(`  FAIL  ${title} — encoded-stream hash mismatch (NOT lossless), leaving as-is`);
      continue;
    }

    const body = await readFile(outPath);
    const newSize = statSync(outPath).size;
    const newKey = s3_key.replace(/\.[^.]+$/, ".mp4");
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: newKey, Body: body, ContentType: "audio/mp4" }));
    await appendFile(REVERT_LOG, JSON.stringify({ id, oldKey: s3_key, newKey }) + "\n");
    await pool.query(
      `update tracks set s3_key=$1, mime_type='audio/mp4', file_size=$2 where id=$3 and mime_type='audio/ogg'`,
      [newKey, newSize, id]
    );
    ok++;
    console.log(`  OK    ${title} — ${(buf.length / 1024).toFixed(0)}KB -> ${(newSize / 1024).toFixed(0)}KB`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${title} — ${err.message}`);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const left = (await pool.query(`select count(*) n from tracks where mime_type='audio/ogg'`)).rows[0].n;
console.log(`\nDone. migrated ${ok}, skipped ${skip}, failed ${fail}. Remaining audio/ogg: ${left}`);
console.log(`Originals kept; revert map appended to ${REVERT_LOG}`);
await pool.end();
