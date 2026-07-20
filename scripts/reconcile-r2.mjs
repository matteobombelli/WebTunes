// Reconcile the R2 bucket against the database: find (and optionally delete)
// objects no track/playlist row references any more, and report the storage
// measurements that gate any future dedup work. Nothing is ever re-encoded -
// this only removes unreferenced bytes.
//
//   node scripts/reconcile-r2.mjs [--apply [--yes]] [--only-remux]
//                                 [--grace-hours=24] [--deep-art-hash] [--report-mpu]
//
// Default is DRY-RUN: lists the bucket, classifies every object, writes a fresh
// snapshot to reconcile-r2-review.jsonl, and prints the measurement report -
// NO deletes. --apply deletes the orphan candidates (re-checking the DB first)
// and appends each deletion to reconcile-r2-revert.jsonl (an audit trail, NOT a
// restore path: object deletes are irreversible); it first echoes the resolved
// bucket/endpoint/DB and requires confirmation (type the bucket name, or pass
// --yes for non-interactive runs). --only-remux restricts an --apply run to the
// provably-safe set proven by remux-revert.jsonl.
//
// Safety (why a still-referenced object can never be deleted):
//   * keys are UUID-derived and never reused, so an orphan stays an orphan;
//   * the DB referenced set is read AFTER the bucket listing (and again right
//     before deleting), so a row committed during the run is still seen;
//   * a grace window on LastModified protects in-flight uploads (S3 put lands
//     seconds before the DB insert in the same request).
// The backups/ prefix is reported but NEVER classified as an orphan.
//
// DATABASE_URL + S3_* come from the process env when set, otherwise merged from
// the .env files (later files win). S3Client construction mirrors src/lib/s3.ts.
import { existsSync, readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
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
  // Merge the .env files in order (later files override earlier), then overlay
  // process.env LAST so an explicitly exported value wins - matching the
  // docstring and the apply-s3-*.mjs scripts. (The previous order let the
  // on-disk files silently override an exported DATABASE_URL/S3_*, which on the
  // destructive --apply path could silently retarget the wrong bucket/DB.)
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

// Client construction must mirror src/lib/s3.ts exactly.
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

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ONLY_REMUX = argv.includes("--only-remux");
const DEEP_ART_HASH = argv.includes("--deep-art-hash");
const REPORT_MPU = argv.includes("--report-mpu");
const graceArg = argv.find((a) => a.startsWith("--grace-hours="))?.split("=")[1];
const GRACE_HOURS = graceArg !== undefined ? Number(graceArg) : 24;
if (!Number.isFinite(GRACE_HOURS) || GRACE_HOURS < 0) {
  console.error(`Invalid --grace-hours=${graceArg}`);
  process.exit(1);
}
const GRACE_MS = GRACE_HOURS * 3600_000;

const REVIEW_LOG = join(root, "reconcile-r2-review.jsonl");
const REVERT_LOG = join(root, "reconcile-r2-revert.jsonl");
const REMUX_LOG = join(root, "remux-revert.jsonl");

const KNOWN_PREFIXES = new Set(["audio", "art", "covers"]);

function prefixOf(key) {
  const i = key.indexOf("/");
  return i === -1 ? "(root)" : key.slice(0, i);
}

function human(bytes) {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}

// --- step 1: list the whole bucket -------------------------------------------
async function listAll() {
  const objects = [];
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    for (const o of page.Contents ?? []) {
      objects.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

// --- step 2: authoritative referenced set ------------------------------------
async function loadReferenced() {
  const referenced = new Set();
  const idToS3Key = new Map();
  const { rows: trackRows } = await pool.query(
    `select id, s3_key, art_s3_key, art_thumb_s3_key from tracks`
  );
  for (const r of trackRows) {
    referenced.add(r.s3_key);
    if (r.art_s3_key) referenced.add(r.art_s3_key);
    if (r.art_thumb_s3_key) referenced.add(r.art_thumb_s3_key);
    idToS3Key.set(r.id, r.s3_key);
  }
  const { rows: plRows } = await pool.query(
    `select cover_s3_key from playlists where cover_s3_key is not null`
  );
  for (const r of plRows) referenced.add(r.cover_s3_key);
  return { referenced, idToS3Key };
}

// --- step 3: remux oracle (oldKey -> {id, newKey}) ---------------------------
function loadRemuxOracle() {
  const oracle = new Map();
  if (!existsSync(REMUX_LOG)) return oracle;
  for (const line of readFileSync(REMUX_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { id, oldKey, newKey } = JSON.parse(line);
      if (oldKey) oracle.set(oldKey, { id, newKey });
    } catch {
      // skip malformed lines
    }
  }
  return oracle;
}

// --- measurement: cross-user duplicate audio (exact, DB only) ----------------
async function reportCrossUserAudioDup() {
  const { rows } = await pool.query(
    `select content_hash,
            count(distinct owner_id) as owners,
            max(file_size) as bytes_each,
            (count(distinct owner_id) - 1) * coalesce(max(file_size), 0) as reclaimable
       from tracks
      where content_hash is not null
      group by content_hash
     having count(distinct owner_id) > 1`
  );
  let extraCopies = 0;
  let reclaimable = 0;
  for (const r of rows) {
    extraCopies += Number(r.owners) - 1;
    reclaimable += Number(r.reclaimable);
  }
  console.log(`\nCross-user duplicate audio (dedup measurement, not acted on):`);
  console.log(
    `  ${rows.length} file(s) held by >1 user; ${extraCopies} redundant copies; ` +
      `~${human(reclaimable)} reclaimable if deduped.`
  );
}

// --- measurement: intra-user duplicate cover art -----------------------------
async function reportIntraUserArtDup(sizeByKey) {
  const { rows } = await pool.query(
    `select owner_id,
            lower(btrim(artist)) as norm_artist,
            lower(btrim(album))  as norm_album,
            art_s3_key, art_thumb_s3_key
       from tracks
      where art_s3_key is not null
        and artist is not null and btrim(artist) <> ''
        and album  is not null and btrim(album)  <> ''`
  );
  // Group by (owner, artist, album); keep one per group, count the rest as dup.
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.owner_id} ${r.norm_artist} ${r.norm_album}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  let dupTracks = 0;
  let reclaimable = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const r of members.slice(1)) {
      dupTracks++;
      reclaimable += sizeByKey.get(r.art_s3_key) ?? 0;
      if (r.art_thumb_s3_key) reclaimable += sizeByKey.get(r.art_thumb_s3_key) ?? 0;
    }
  }
  console.log(`\nIntra-user duplicate cover art (estimate by artist+album):`);
  console.log(
    `  ${dupTracks} track(s) reuse an album image already stored; ` +
      `~${human(reclaimable)} reclaimable if deduped.`
  );

  if (DEEP_ART_HASH) await reportArtDupExact(rows, sizeByKey);
}

// --deep-art-hash: download every art object and group by (owner, sha256) for an
// exact figure (images are small; costs one GET per object).
async function reportArtDupExact(rows, sizeByKey) {
  console.log(`  [--deep-art-hash] hashing ${rows.length} art object(s)…`);
  const hashByKey = new Map();
  let cursor = 0;
  let failed = 0;
  async function worker() {
    while (cursor < rows.length) {
      const r = rows[cursor++];
      try {
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET, Key: r.art_s3_key })
        );
        const buf = Buffer.from(await obj.Body.transformToByteArray());
        hashByKey.set(r.art_s3_key, createHash("sha256").update(buf).digest("hex"));
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const groups = new Map();
  for (const r of rows) {
    const h = hashByKey.get(r.art_s3_key);
    if (!h) continue;
    const k = `${r.owner_id} ${h}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  let dupTracks = 0;
  let reclaimable = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const r of members.slice(1)) {
      dupTracks++;
      reclaimable += sizeByKey.get(r.art_s3_key) ?? 0;
      if (r.art_thumb_s3_key) reclaimable += sizeByKey.get(r.art_thumb_s3_key) ?? 0;
    }
  }
  console.log(
    `  exact (by content hash): ${dupTracks} duplicate art object(s); ` +
      `~${human(reclaimable)} reclaimable${failed ? ` (${failed} unreadable)` : ""}.`
  );
}

// --- measurement: incomplete multipart uploads (invisible to ListObjectsV2) --
async function reportIncompleteMultipart() {
  console.log(`\nIncomplete multipart uploads (invisible to object listing):`);
  try {
    let keyMarker;
    let idMarker;
    let count = 0;
    do {
      const page = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: BUCKET,
          KeyMarker: keyMarker,
          UploadIdMarker: idMarker,
        })
      );
      for (const u of page.Uploads ?? []) {
        count++;
        console.log(`  ${u.Key} - initiated ${u.Initiated?.toISOString?.() ?? u.Initiated}`);
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    if (count === 0) console.log(`  none.`);
    else console.log(`  ${count} incomplete upload(s) - set a lifecycle rule (scripts/apply-s3-lifecycle.mjs).`);
  } catch (err) {
    console.log(`  could not list (likely needs an admin token): ${err.message}`);
  }
}

// --- main --------------------------------------------------------------------
console.log(
  `reconcile-r2 - ${APPLY ? (ONLY_REMUX ? "APPLY (remux-only)" : "APPLY") : "DRY-RUN"} | ` +
    `grace ${GRACE_HOURS}h | bucket ${BUCKET}`
);
if (!APPLY) console.log(`(dry-run: no deletes; snapshot -> ${REVIEW_LOG})`);

console.log(`\nListing bucket…`);
const objects = await listAll();
const { referenced, idToS3Key } = await loadReferenced();
const oracle = loadRemuxOracle();
const now = Date.now();

const sizeByKey = new Map(objects.map((o) => [o.key, o.size]));
const bytesByPrefix = new Map();
let totalBytes = 0;

const candidates = []; // { key, size, lastModified, reason }
const skippedRecent = [];
const unknown = [];
let remuxOrphanCount = 0;

for (const o of objects) {
  const prefix = prefixOf(o.key);
  bytesByPrefix.set(prefix, (bytesByPrefix.get(prefix) ?? 0) + o.size);
  totalBytes += o.size;

  if (prefix === "backups") continue; // bounded + pruned nightly; never touch
  if (referenced.has(o.key)) continue;

  if (!KNOWN_PREFIXES.has(prefix)) {
    unknown.push({ key: o.key, size: o.size, lastModified: o.lastModified });
    continue;
  }

  const ageMs = o.lastModified ? now - o.lastModified.getTime() : Infinity;
  if (ageMs <= GRACE_MS) {
    skippedRecent.push({ key: o.key, size: o.size, lastModified: o.lastModified });
    continue;
  }

  // remux-orphan iff the revert log maps this key to a newKey the DB now uses.
  const mapped = oracle.get(o.key);
  const reason =
    mapped && idToS3Key.get(mapped.id) === mapped.newKey ? "remux-orphan" : "orphan";
  if (reason === "remux-orphan") remuxOrphanCount++;
  candidates.push({
    key: o.key,
    size: o.size,
    lastModified: o.lastModified ? o.lastModified.toISOString() : null,
    reason,
  });
}

// --- report ------------------------------------------------------------------
console.log(`\nBucket: ${objects.length} objects, ${human(totalBytes)} total.`);
console.log(`Bytes by prefix:`);
for (const [p, b] of [...bytesByPrefix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(10)} ${human(b)}`);
}

const orphanBytes = candidates.reduce((s, c) => s + c.size, 0);
const remuxBytes = candidates
  .filter((c) => c.reason === "remux-orphan")
  .reduce((s, c) => s + c.size, 0);
console.log(`\nOrphan candidates: ${candidates.length} (${human(orphanBytes)})`);
console.log(
  `  remux-orphan: ${remuxOrphanCount} (${human(remuxBytes)}) | ` +
    `other orphan: ${candidates.length - remuxOrphanCount} (${human(orphanBytes - remuxBytes)})`
);
console.log(
  `  remux oracle has ${oracle.size} entries; ${remuxOrphanCount} still present as orphans` +
    (oracle.size === remuxOrphanCount ? " (full match)." : " (already partly cleaned or re-deleted).")
);
console.log(`Skipped (younger than grace): ${skippedRecent.length}`);
console.log(`Unknown-prefix objects (never auto-deleted): ${unknown.length}`);
for (const u of unknown) console.log(`  ?? ${u.key} (${human(u.size)})`);

await reportCrossUserAudioDup();
await reportIntraUserArtDup(sizeByKey);
if (REPORT_MPU) await reportIncompleteMultipart();

// Destructive guard: --apply deletes irreversibly, so echo the resolved target
// and require confirmation. A TTY gets an interactive prompt; non-interactive
// runs must pass --yes.
async function confirmApply(count) {
  let dbHost = "(unparseable)";
  try {
    dbHost = new URL(env.DATABASE_URL).host;
  } catch {
    // keep the placeholder
  }
  console.log(
    `\n!! APPLY will irreversibly DELETE ${count} object(s) from:\n` +
      `   bucket:   ${BUCKET}\n` +
      `   endpoint: ${env.S3_ENDPOINT || "(aws default)"}\n` +
      `   database: ${dbHost}\n` +
      `   (the revert log is an audit trail, NOT a restore path)`
  );
  if (count === 0) return true;
  if (argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    console.error("Refusing to delete without confirmation; re-run with --yes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`Type the bucket name to proceed (${BUCKET}): `, res)
  );
  rl.close();
  if (answer.trim() !== BUCKET) {
    console.log("Confirmation did not match; aborting.");
    return false;
  }
  return true;
}

// --- act ---------------------------------------------------------------------
if (!APPLY) {
  const lines = [
    ...candidates.map((c) => ({ kind: "orphan-candidate", ...c })),
    ...skippedRecent.map((c) => ({
      kind: "skipped-recent",
      ...c,
      lastModified: c.lastModified ? c.lastModified.toISOString() : null,
      reason: "skipped-recent",
    })),
    ...unknown.map((c) => ({
      kind: "unknown",
      ...c,
      lastModified: c.lastModified ? c.lastModified.toISOString() : null,
      reason: "unknown-prefix",
    })),
  ];
  await writeFile(REVIEW_LOG, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  console.log(`\nDRY-RUN: wrote ${lines.length} row(s) to ${REVIEW_LOG}. No objects deleted.`);
  await pool.end();
} else {
  // Re-read the referenced set right before deleting to close the review->apply gap.
  const { referenced: fresh } = await loadReferenced();
  const toDelete = candidates.filter((c) => (ONLY_REMUX ? c.reason === "remux-orphan" : true));
  if (!(await confirmApply(toDelete.length))) {
    console.log("Aborted - no objects deleted.");
    await pool.end();
    process.exit(1);
  }
  let deleted = 0;
  let reclaimed = 0;
  let skipped = 0;
  for (const c of toDelete) {
    if (fresh.has(c.key)) {
      skipped++;
      continue; // became referenced since listing - never expected, but cheap
    }
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: c.key }));
      await appendFile(
        REVERT_LOG,
        JSON.stringify({ ...c, deletedAt: new Date().toISOString() }) + "\n"
      );
      deleted++;
      reclaimed += c.size;
    } catch (err) {
      skipped++;
      console.warn(`  FAIL delete ${c.key}: ${err.message}`);
    }
  }
  console.log(
    `\nAPPLY: deleted ${deleted} object(s), reclaimed ${human(reclaimed)}` +
      `${skipped ? `, skipped ${skipped}` : ""}. Audit -> ${REVERT_LOG}`
  );
  await pool.end();
}
