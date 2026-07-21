// Selectively recover listen history and denormalized friend-listen counters
// from an R2 pg_dump without overwriting the live database. Recovered listen
// rows remain available to Discover/friend activity but are excluded from Stats.
//
// Dry-run (downloads + restores into a temporary database, live DB untouched):
//   node scripts/restore-listen-history.mjs --backup-key=backups/webtunes-....dump
// Apply (stop webtunes.service first):
//   node scripts/restore-listen-history.mjs --backup-key=... --apply
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const { Client } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];
const apply = process.argv.includes("--apply");
const backupKey = process.argv
  .find((arg) => arg.startsWith("--backup-key="))
  ?.slice("--backup-key=".length);

if (!backupKey || !backupKey.startsWith("backups/") || !backupKey.endsWith(".dump")) {
  console.error("Pass --backup-key=backups/<webtunes-backup>.dump");
  process.exit(1);
}

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
  let fileEnv = {};
  for (const file of ENV_FILES) {
    const path = join(root, file);
    if (existsSync(path)) fileEnv = { ...fileEnv, ...parseEnvFile(path) };
  }
  return { ...fileEnv, ...process.env };
}

function run(command, args, { inputPath } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: root,
      env: { ...process.env, PGPASSWORD: dbPassword },
      stdio: [inputPath ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    if (inputPath) createReadStream(inputPath).pipe(proc.stdin);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function dockerPostgres(...args) {
  return run("docker", [
    "compose",
    "exec",
    "-T",
    "-e",
    "PGPASSWORD",
    "postgres",
    ...args,
  ]);
}

async function insertRecoveredListens(client, rows) {
  let inserted = 0;
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = await client.query(
      `INSERT INTO listens
         (id, user_id, track_id, played_at, include_in_stats)
       SELECT recovered.id, recovered.user_id, recovered.track_id,
              recovered.played_at, false
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamp[])
         AS recovered(id, user_id, track_id, played_at)
       INNER JOIN users ON users.id = recovered.user_id
       INNER JOIN tracks ON tracks.id = recovered.track_id
       ON CONFLICT (id) DO NOTHING`,
      [
        batch.map((row) => row.id),
        batch.map((row) => row.user_id),
        batch.map((row) => row.track_id),
        batch.map((row) => row.played_at.toISOString()),
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function addRecoveredFriendCounts(client, rows) {
  const nonzero = rows.filter((row) => row.friend_play_count > 0);
  if (!nonzero.length) return 0;
  const result = await client.query(
    `UPDATE tracks
     SET friend_play_count = tracks.friend_play_count + recovered.play_count
     FROM unnest($1::uuid[], $2::int[])
       AS recovered(id, play_count)
     WHERE tracks.id = recovered.id`,
    [
      nonzero.map((row) => row.id),
      nonzero.map((row) => row.friend_play_count),
    ]
  );
  return result.rowCount ?? 0;
}

const env = loadEnv();
if (!env.DATABASE_URL || !env.S3_BUCKET) {
  console.error("Missing DATABASE_URL or S3_BUCKET.");
  process.exit(1);
}

const dbUrl = new URL(env.DATABASE_URL);
const dbUser = decodeURIComponent(dbUrl.username);
const dbPassword = decodeURIComponent(dbUrl.password);
const recoveryDb = `webtunes_listen_recovery_${process.pid}`;
const recoveryUrl = new URL(env.DATABASE_URL);
recoveryUrl.pathname = `/${recoveryDb}`;
const dumpPath = join(tmpdir(), `${recoveryDb}.dump`);
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

let recoveryClient;
let liveClient;
try {
  console.log(`Downloading ${backupKey}...`);
  const object = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: backupKey })
  );
  if (!object.Body) throw new Error("Backup object has no body");
  await pipeline(object.Body, createWriteStream(dumpPath));

  await dockerPostgres(
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    dbUser,
    "-d",
    "postgres",
    "-c",
    `CREATE DATABASE ${recoveryDb}`
  );
  await run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "pg_restore",
      "-U",
      dbUser,
      "-d",
      recoveryDb,
      "--no-owner",
      "--no-privileges",
    ],
    { inputPath: dumpPath }
  );

  recoveryClient = new Client({ connectionString: recoveryUrl.toString() });
  liveClient = new Client({ connectionString: env.DATABASE_URL });
  await Promise.all([recoveryClient.connect(), liveClient.connect()]);

  const [backupListens, backupFriendCounts, liveSchema] = await Promise.all([
    recoveryClient.query(
      `SELECT id, user_id, track_id, played_at FROM listens
       ORDER BY played_at, id`
    ),
    recoveryClient.query(
      `SELECT id, friend_play_count FROM tracks WHERE friend_play_count > 0`
    ),
    liveClient.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'listens'
           AND column_name = 'include_in_stats'
       ) AS recovery_schema_ready`
    ),
  ]);
  const schemaReady = liveSchema.rows[0].recovery_schema_ready;
  const liveState = schemaReady
    ? await liveClient.query(
        `SELECT
           count(*)::int AS current_listens,
           count(*) FILTER (WHERE include_in_stats = false)::int AS recovered_listens
         FROM listens`
      )
    : await liveClient.query(
        `SELECT count(*)::int AS current_listens, 0::int AS recovered_listens
         FROM listens`
      );

  const friendTotal = backupFriendCounts.rows.reduce(
    (sum, row) => sum + row.friend_play_count,
    0
  );
  console.log(
    `Backup contains ${backupListens.rowCount} listens and ${friendTotal} friend listens.`
  );
  console.log(
    `Live database currently contains ${liveState.rows[0].current_listens} listens.`
  );

  if (!apply) {
    if (!schemaReady) {
      console.log("Migration 0027 must be applied before recovery.");
    }
    console.log("Dry run complete. Re-run with --apply after stopping webtunes.service.");
  } else {
    if (!schemaReady) {
      throw new Error("Apply migration 0027 before running recovery.");
    }
    if (liveState.rows[0].recovered_listens > 0) {
      throw new Error(
        "Recovery already appears to have run (include_in_stats=false rows exist)."
      );
    }
    await liveClient.query("BEGIN");
    try {
      const inserted = await insertRecoveredListens(
        liveClient,
        backupListens.rows
      );
      const updatedTracks = await addRecoveredFriendCounts(
        liveClient,
        backupFriendCounts.rows
      );
      await liveClient.query("COMMIT");
      console.log(
        `Recovered ${inserted} listen rows and friend counts for ${updatedTracks} tracks.`
      );
      if (inserted !== backupListens.rowCount) {
        console.log(
          `${backupListens.rowCount - inserted} rows referenced users/tracks no longer present and were skipped.`
        );
      }
    } catch (error) {
      await liveClient.query("ROLLBACK");
      throw error;
    }
  }
} catch (error) {
  console.error(`Recovery failed: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([recoveryClient?.end(), liveClient?.end()]);
  await dockerPostgres(
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    dbUser,
    "-d",
    "postgres",
    "-c",
    `DROP DATABASE IF EXISTS ${recoveryDb} WITH (FORCE)`
  ).catch((error) => console.error(`Temporary DB cleanup failed: ${error.message}`));
  await rm(dumpPath, { force: true }).catch(() => {});
}
