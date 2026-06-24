// One-time backfill: re-extracts embedded metadata (title/artist/album/
// duration/lyrics/cover art) for tracks that were uploaded while the running
// server pointed at a deleted `.next` build. In that state music-metadata's
// lazily-imported format-parser chunks were missing from disk, so parseBuffer
// threw, the upload route's best-effort catch swallowed it, and every track
// landed with a filename-only title and null artist/album/duration/art.
//   node scripts/backfill-metadata.mjs
// Affected rows are identified by artist+album+art_s3_key all NULL. Re-running
// is idempotent: a genuinely untagged file recovers nothing and is left as-is.
// DATABASE_URL + S3_* come from the process environment when set, otherwise
// from the first env file present. Mirrors scripts/analyze-loudness.mjs.
import { existsSync, readFileSync } from "node:fs";
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

// --- allowlist mirror of src/lib/image-upload.ts (imageKindFromMime) ---------
const JPEG = { ext: "jpg", contentType: "image/jpeg" };
const BY_MIME = {
  "image/jpeg": JPEG,
  "image/png": { ext: "png", contentType: "image/png" },
  "image/webp": { ext: "webp", contentType: "image/webp" },
  "image/gif": { ext: "gif", contentType: "image/gif" },
};
const imageKindFromMime = (mime) => BY_MIME[mime ?? ""] ?? JPEG;

// --- embedded-lyrics mirror of src/lib/metadata.ts ---------------------------
function embeddedLyrics(meta) {
  const tag = meta.common.lyrics?.[0];
  if (tag) {
    if (typeof tag === "string") return tag;
    if (tag.text) return tag.text;
    if (tag.syncText?.length)
      return tag.syncText.map((line) => line.text).join("\n");
  }
  for (const frames of Object.values(meta.native)) {
    for (const frame of frames) {
      if (!/^(TXXX:)?(USLT|LYRICS|UNSYNCEDLYRICS)/i.test(frame.id)) continue;
      const value = frame.value;
      if (typeof value === "string" && value.trim()) return value.trim();
      if (
        value &&
        typeof value === "object" &&
        "text" in value &&
        typeof value.text === "string" &&
        value.text.trim()
      )
        return value.text.trim();
    }
  }
  return null;
}

async function fetchLrclibLyrics(artist, title, album, durationSec) {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("artist_name", artist);
  url.searchParams.set("track_name", title);
  if (album) url.searchParams.set("album_name", album);
  if (durationSec) url.searchParams.set("duration", String(durationSec));
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "WebTunes/0.1 (personal project)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.plainLyrics?.trim() || null;
  } catch {
    return null;
  }
}

async function downloadObject(key, signal) {
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { abortSignal: signal }
  );
  return Buffer.from(await obj.Body.transformToByteArray());
}

// Wall-clock cap so one stalled S3 read can't wedge the whole backfill
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

const { rows } = await pool.query(
  `select id, owner_id, s3_key, title
     from tracks
    where artist is null and album is null and art_s3_key is null
    order by created_at`
);
console.log(`${rows.length} candidate track(s) to re-extract.`);

// Bounded worker pool: candidates are I/O-bound (S3 download + lrclib's 8s
// timeout per lyric miss), so a serial pass over ~1.5k rows takes hours.
// CONCURRENCY workers pull from a shared cursor; JS is single-threaded so the
// shared counters are race-free.
const CONCURRENCY = 8;

let updated = 0;
let unchanged = 0;
let failed = 0;
let processed = 0;

async function processTrack({ id, owner_id, s3_key, title: currentTitle }) {
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
      meta = await parseBuffer(
        buffer,
        { mimeType, size: buffer.length },
        { duration: true }
      );
    } catch {
      // still unparseable — leave the row alone
    }

    if (!meta) {
      unchanged++;
      console.warn(`  ${id} — unparseable, left as-is`);
      return;
    }

    const tagTitle = meta.common.title?.trim() || null;
    const artist = meta.common.artist?.trim() || null;
    const album = meta.common.album?.trim() || null;
    const durationSec = meta.format.duration
      ? Math.round(meta.format.duration)
      : null;

    let lyrics = embeddedLyrics(meta);
    let lyricsSource = lyrics ? "embedded" : "none";
    if (!lyrics && artist) {
      lyrics = await fetchLrclibLyrics(
        artist,
        tagTitle || currentTitle,
        album,
        durationSec
      );
      if (lyrics) lyricsSource = "lrclib";
    }

    const picture = meta.common.picture?.[0];
    let artS3Key = null;
    if (picture?.data) {
      const kind = imageKindFromMime(picture.format ?? null);
      artS3Key = `art/${owner_id}/${id}.${kind.ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: artS3Key,
          Body: Buffer.from(picture.data),
          ContentType: kind.contentType,
        })
      );
    }

    // Only write columns we actually recovered; never clobber good data with
    // null. Title is overwritten only when a real tag title exists (replacing
    // the filename fallback).
    const sets = [];
    const vals = [];
    const set = (col, val) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (tagTitle && tagTitle !== currentTitle) set("title", tagTitle);
    if (artist) set("artist", artist);
    if (album) set("album", album);
    if (durationSec) set("duration_sec", durationSec);
    if (artS3Key) set("art_s3_key", artS3Key);
    if (lyrics) {
      set("lyrics", lyrics);
      set("lyrics_source", lyricsSource);
    }

    if (sets.length === 0) {
      unchanged++;
      console.log(`  ${id} — no embedded metadata found, left as-is`);
      return;
    }

    vals.push(id);
    await pool.query(
      `update tracks set ${sets.join(", ")} where id = $${vals.length}`,
      vals
    );
    updated++;
    console.log(
      `  ${id} — ${[
        tagTitle && tagTitle !== currentTitle && `title="${tagTitle}"`,
        artist && `artist="${artist}"`,
        album && `album="${album}"`,
        durationSec && `${durationSec}s`,
        artS3Key && "art",
        lyrics && `lyrics(${lyricsSource})`,
      ]
        .filter(Boolean)
        .join(", ")}`
    );
  } catch (err) {
    failed++;
    console.warn(`  ${id} — failed: ${err.message}`);
  }
}

let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    await processTrack(row);
    if (++processed % 50 === 0)
      console.log(`… ${processed}/${rows.length} processed`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(
  `Done. ${updated} updated, ${unchanged} left as-is, ${failed} failed.`
);
await pool.end();
