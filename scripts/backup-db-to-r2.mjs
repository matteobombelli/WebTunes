// Nightly database backup: dumps the Postgres database and uploads it to R2
// under the backups/ prefix, then prunes to the KEEP newest dumps.
//   node scripts/backup-db-to-r2.mjs
// pg_dump runs INSIDE the postgres container via `docker compose exec`, so it
// always matches the server version and the host needs no postgres client
// installed — but it does require Docker + the compose project to be up, and
// must run from the repo root (the systemd unit sets WorkingDirectory; `cwd:
// root` covers manual runs). DATABASE_URL + S3_* come from the process
// environment when set, otherwise merged from the .env files (later files win).
// On prod a
// systemd timer runs this daily (see deploy/). Restore a dump with:
//   docker compose exec -T postgres pg_restore -U webtunes -d webtunes \
//     --clean --if-exists < webtunes-<ts>.dump
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

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
  // Merge the .env files in order (later files override earlier), then overlay
  // process.env LAST so an explicitly exported value wins — matching the
  // docstring and the apply-s3-*.mjs scripts. (The previous order let the
  // on-disk files silently override an exported DATABASE_URL/S3_*.)
  let fileEnv = {};
  for (const f of ENV_FILES) {
    const path = join(root, f);
    if (existsSync(path)) fileEnv = { ...fileEnv, ...parseEnvFile(path) };
  }
  return { ...fileEnv, ...process.env };
}

const env = loadEnv();

if (!env.DATABASE_URL || !env.S3_BUCKET) {
  console.error("Missing DATABASE_URL or S3_BUCKET in the environment.");
  process.exit(1);
}

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

const PREFIX = "backups/";
const KEEP = 7;

// pg_dump runs against the container's local socket as the role/db encoded in
// DATABASE_URL, so this tracks the configured database without hardcoding names.
const dbUrl = new URL(env.DATABASE_URL);
const DB_USER = decodeURIComponent(dbUrl.username);
const DB_PASSWORD = decodeURIComponent(dbUrl.password);
const DB_NAME = dbUrl.pathname.slice(1);

// Dump straight to `outPath` and resolve only once BOTH the process exited 0 and
// the file finished flushing — staging to disk (rather than streaming pg_dump
// straight to R2) lets us reject a truncated archive before it's published.
// -Fc = compressed custom format, restorable with pg_restore.
function dumpToFile(outPath) {
  const out = createWriteStream(outPath);
  const proc = spawn(
    "docker",
    [
      "compose", "exec", "-T",
      // Pass PGPASSWORD by NAME (no value) so the secret rides the child's
      // environment (/proc/<pid>/environ, owner-only) instead of its argv
      // (/proc/<pid>/cmdline, world-readable). `docker compose exec -e NAME`
      // forwards the value from this process's environment into the container.
      "-e", "PGPASSWORD",
      "postgres",
      "pg_dump", "-U", DB_USER, "-Fc", DB_NAME,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PGPASSWORD: DB_PASSWORD },
    }
  );
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  proc.stdout.pipe(out);

  const procDone = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`))
    );
  });
  const streamDone = new Promise((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", resolve);
  });
  return Promise.all([procDone, streamDone]);
}

async function prune() {
  // The prefix filter guarantees only backups/ keys are ever listed/deleted —
  // audio objects elsewhere in the bucket can never be touched.
  const { Contents = [] } = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX })
  );
  const backups = Contents.filter((o) => o.Key.endsWith(".dump")).sort(
    (a, b) => b.LastModified - a.LastModified
  );
  const stale = backups.slice(KEEP);
  for (const obj of stale) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    console.log(`Pruned ${obj.Key}`);
  }
  console.log(
    `Retention: kept ${Math.min(backups.length, KEEP)}, pruned ${stale.length}.`
  );
}

const tmpPath = join(tmpdir(), `webtunes-backup-${process.pid}.dump`);
try {
  console.log(`Dumping ${DB_NAME} via docker compose exec pg_dump…`);
  await dumpToFile(tmpPath);
  const { size } = statSync(tmpPath);
  if (size === 0) throw new Error("pg_dump produced an empty file");

  const key = `${PREFIX}webtunes-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.dump`;
  await new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: createReadStream(tmpPath),
      ContentType: "application/octet-stream",
    },
  }).done();
  console.log(`Uploaded ${key} (${(size / 1024 / 1024).toFixed(2)} MiB)`);

  await prune();
  console.log("Backup complete.");
} catch (err) {
  console.error(`Backup failed: ${err.message ?? err}`);
  process.exitCode = 1;
} finally {
  await rm(tmpPath, { force: true }).catch(() => {});
}
