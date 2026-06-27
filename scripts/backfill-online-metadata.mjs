// Backfill missing cover art for tracks that have no stored art, in two phases
// (run in order unless --phase selects one):
//   reextract — local: a few tracks have embedded art that was never pulled at
//               upload; recover it cheaply before any network call.
//   art       — iTunes Search (no key): cover art for tracks that have an
//               artist+album but no art.
//
//   node scripts/backfill-online-metadata.mjs [--phase=reextract|art] [--apply] [--limit=N]
//
// Default is DRY-RUN: performs the network reads (proposals are real) but does
// NO S3 puts and NO DB updates — each proposal is appended to
// backfill-online-review.jsonl for eyeballing. --apply performs the writes and
// logs old->new to backfill-online-revert.jsonl (both files are append-only).
//
// DATABASE_URL + S3_* come from the process env when set, otherwise from the
// first env file present. Mirrors scripts/backfill-metadata.mjs and
// src/lib/metadata-lookup.ts (keep the iTunes/sniff logic in sync).
import { existsSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { parseBuffer } from "music-metadata";
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

const UA = "WebTunes/0.1 (personal project)";

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const phaseArg = argv.find((a) => a.startsWith("--phase="))?.split("=")[1];
const limitArg = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;
const ALL_PHASES = ["reextract", "art"];
if (phaseArg && !ALL_PHASES.includes(phaseArg)) {
  console.error(`unknown --phase=${phaseArg} (use ${ALL_PHASES.join("|")})`);
  process.exit(1);
}
const PHASES = phaseArg ? [phaseArg] : ALL_PHASES;

const REVIEW_LOG = join(root, "backfill-online-review.jsonl");
const REVERT_LOG = join(root, "backfill-online-revert.jsonl");
const review = (e) => appendFile(REVIEW_LOG, JSON.stringify(e) + "\n");
const revert = (e) => appendFile(REVERT_LOG, JSON.stringify(e) + "\n");

// --- constants (mirror src/lib/metadata-lookup.ts) ---------------------------
const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;

// --- allowlist mirror of src/lib/image-upload.ts -----------------------------
const JPEG = { ext: "jpg", contentType: "image/jpeg" };
const PNG = { ext: "png", contentType: "image/png" };
const WEBP = { ext: "webp", contentType: "image/webp" };
const GIF = { ext: "gif", contentType: "image/gif" };
const BY_MIME = {
  "image/jpeg": JPEG,
  "image/png": PNG,
  "image/webp": WEBP,
  "image/gif": GIF,
};
const imageKindFromMime = (mime) => BY_MIME[mime ?? ""] ?? JPEG;

function imageKindFromBytes(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return JPEG;
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return PNG;
  if (
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  )
    return GIF;
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return WEBP;
  return null;
}

// --- polite iTunes rate limiter (~20/min; the 8-worker pool would get banned) -
class Limiter {
  constructor(minMs) {
    this.minMs = minMs;
    this.last = 0;
  }
  async wait() {
    const waitMs = this.last + this.minMs - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    this.last = Date.now();
  }
}
const itunesLimiter = new Limiter(3100);

// --- helpers (mirror analyze-loudness.mjs / metadata-lookup.ts) --------------
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

async function downloadObject(key, signal) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    abortSignal: signal,
  });
  return Buffer.from(await obj.Body.transformToByteArray());
}

function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_ART_BYTES) return null;
    const kind = imageKindFromBytes(body); // never trust the remote type
    return kind ? { body, kind } : null;
  } catch {
    return null;
  }
}

async function itunesArtUrl(term, wantArtist) {
  await itunesLimiter.wait();
  const url = new URL(ITUNES_ENDPOINT);
  url.searchParams.set("term", term);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "5");
  url.searchParams.set("country", "US");
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const match = (data.results ?? []).find((r) => {
    if (!r.artworkUrl100 || !r.artistName) return false;
    const got = normalize(r.artistName);
    return got === wantArtist || got.includes(wantArtist);
  });
  return match?.artworkUrl100?.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1") ?? null;
}

// Returns { body, kind, source, url } | null. iTunes by title, then album.
async function findArt(q) {
  if (!q.artist) return null;
  const want = normalize(q.artist);
  const terms = [`${q.artist} ${q.title}`.trim()];
  if (q.album) terms.push(`${q.artist} ${q.album}`.trim());
  for (const term of terms) {
    try {
      const url = await itunesArtUrl(term, want);
      if (url) {
        const img = await downloadImage(url);
        if (img) return { ...img, source: "itunes", url };
      }
    } catch {
      // try the next term
    }
  }
  return null;
}

async function putArt(ownerId, id, art) {
  const key = `art/${ownerId}/${id}.${art.kind.ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: art.body,
      ContentType: art.kind.contentType,
    })
  );
  return key;
}

const limitSql = LIMIT ? ` limit ${LIMIT}` : "";

// --- Phase 0: local re-extract of embedded art (8-worker pool, no network) ---
async function phaseReextract() {
  const { rows } = await pool.query(
    `select id, owner_id, s3_key from tracks
      where art_s3_key is null and artist is not null and album is not null
      order by created_at` + limitSql
  );
  console.log(`\n[reextract] ${rows.length} arted-less track(s) — checking for embedded art.`);
  let found = 0,
    none = 0,
    failed = 0,
    processed = 0,
    cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const { id, owner_id, s3_key } = rows[cursor++];
      try {
        const controller = new AbortController();
        const buffer = await withTimeout(
          downloadObject(s3_key, controller.signal),
          90_000,
          () => controller.abort()
        );
        const ext = s3_key.split(".").pop()?.toLowerCase() ?? "";
        const mimeType = ext === "mp3" ? "audio/mpeg" : "";
        let meta = null;
        try {
          meta = await parseBuffer(buffer, { mimeType, size: buffer.length }, { duration: false });
        } catch {
          // unparseable — nothing to recover
        }
        const picture = meta?.common?.picture?.[0];
        if (!picture?.data) {
          none++;
        } else if (APPLY) {
          const kind = imageKindFromMime(picture.format ?? null);
          const key = await putArt(owner_id, id, { body: Buffer.from(picture.data), kind });
          await pool.query(
            `update tracks set art_s3_key = $1 where id = $2 and art_s3_key is null`,
            [key, id]
          );
          await revert({ phase: "reextract", id, old: { art_s3_key: null }, new: { art_s3_key: key } });
          found++;
          console.log(`  ${id} — embedded art recovered`);
        } else {
          const kind = imageKindFromMime(picture.format ?? null);
          await review({ phase: "reextract", id, art: { source: "embedded", ext: kind.ext } });
          found++;
          console.log(`  ${id} — embedded art FOUND (dry-run)`);
        }
      } catch (err) {
        failed++;
        console.warn(`  ${id} — failed: ${err.message}`);
      }
      if (++processed % 100 === 0) console.log(`  … ${processed}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`[reextract] done. ${found} with embedded art${APPLY ? " stored" : " (dry-run)"}, ${none} none, ${failed} failed.`);
}

// --- Phase 1: cover art via iTunes for already-tagged tracks (serial) --------
async function phaseArt() {
  const { rows } = await pool.query(
    `select id, owner_id, artist, album, title from tracks
      where art_s3_key is null and artist is not null and album is not null
      order by created_at` + limitSql
  );
  console.log(`\n[art] ${rows.length} track(s) needing cover art via iTunes.`);
  let found = 0,
    miss = 0,
    failed = 0,
    processed = 0;
  for (const { id, owner_id, artist, album, title } of rows) {
    try {
      const art = await findArt({ artist, album, title });
      if (!art) {
        miss++;
      } else if (APPLY) {
        const key = await putArt(owner_id, id, art);
        await pool.query(
          `update tracks set art_s3_key = $1 where id = $2 and art_s3_key is null`,
          [key, id]
        );
        await revert({ phase: "art", id, old: { art_s3_key: null }, new: { art_s3_key: key } });
        found++;
        console.log(`  ${id} — art via ${art.source}`);
      } else {
        await review({ phase: "art", id, artist, album, title, art: { source: art.source, url: art.url, ext: art.kind.ext } });
        found++;
        console.log(`  ${id} — art via ${art.source} (dry-run): ${art.url}`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ${id} — failed: ${err.message}`);
    }
    if (++processed % 50 === 0) console.log(`  … ${processed}/${rows.length}`);
  }
  console.log(`[art] done. ${found} art ${APPLY ? "stored" : "found (dry-run)"}, ${miss} no match, ${failed} failed.`);
}

console.log(
  `backfill-online-metadata — ${APPLY ? "APPLY" : "DRY-RUN"} | phases: ${PHASES.join(", ")}${LIMIT ? ` | limit ${LIMIT}` : ""}`
);
if (!APPLY) console.log(`(dry-run: no S3/DB writes; proposals -> ${REVIEW_LOG})`);

for (const phase of PHASES) {
  if (phase === "reextract") await phaseReextract();
  else if (phase === "art") await phaseArt();
}

await pool.end();
