// Backfill MISSING artist/album/cover-art for existing tracks via acoustic
// fingerprinting — the offline mirror of the live recognition worker
// (src/lib/recognize-queue.ts + src/lib/recognize.ts): fpcalc/Chromaprint
// fingerprint -> AcoustID -> artist/album + release-group MBID -> Cover Art
// Archive front cover, with the iTunes lookup as the art fallback. Only EMPTY
// fields are filled; existing data is NEVER overwritten; the title is never
// touched.
//
//   node scripts/recognize-missing-metadata.mjs [--apply] [--limit=N]
//
// Default is DRY-RUN: performs the network reads (proposals are real) but does
// NO S3 puts and NO DB updates — each proposal is appended to
// recognize-missing-review.jsonl. --apply performs the writes and logs old->new
// to recognize-missing-revert.jsonl (both append-only).
//
// Requires fpcalc + ffmpeg on PATH. ACOUSTID_API_KEY enables fingerprint
// recognition; without it the script runs art-fallback-only (iTunes by existing
// tags), exactly like the worker. DATABASE_URL + S3_* come from the process env
// when set, otherwise from the first env file present. Keep the AcoustID/iTunes/
// sniff/thumbnail logic in sync with src/lib/{recognize,metadata-lookup,
// image-upload,thumbnail}.ts.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const ACOUSTID_KEY = env.ACOUSTID_API_KEY || null;

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const limitArg = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;

const REVIEW_LOG = join(root, "recognize-missing-review.jsonl");
const REVERT_LOG = join(root, "recognize-missing-revert.jsonl");
const review = (e) => appendFile(REVIEW_LOG, JSON.stringify(e) + "\n");
const revert = (e) => appendFile(REVERT_LOG, JSON.stringify(e) + "\n");

// --- constants (mirror src/lib/recognize.ts + metadata-lookup.ts) ------------
const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";
const CAA_ENDPOINT = "https://coverartarchive.org";
const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;
const FPCALC_TIMEOUT_MS = 30_000;
const MIN_SCORE = 0.5;

// --- allowlist mirror of src/lib/image-upload.ts -----------------------------
const JPEG = { ext: "jpg", contentType: "image/jpeg" };
const PNG = { ext: "png", contentType: "image/png" };
const WEBP = { ext: "webp", contentType: "image/webp" };
const GIF = { ext: "gif", contentType: "image/gif" };

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

// --- thumbnail mirror of src/lib/thumbnail.ts --------------------------------
const THUMB_PX = 256;
const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
const THUMBNAIL_EXT = "thumb.jpg";

// --- rate limiters -----------------------------------------------------------
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
// AcoustID asks ≤3 req/s; Cover Art Archive ≤1 req/s — share a polite gate.
const acoustidLimiter = new Limiter(350);
const itunesLimiter = new Limiter(3100);

// --- helpers -----------------------------------------------------------------
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

// --- fingerprint (mirror src/lib/recognize.ts) -------------------------------
function runFpcalc(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("fpcalc", ["-json", inputPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), FPCALC_TIMEOUT_MS);
    proc.on("error", (err) => (clearTimeout(timer), reject(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(`fpcalc exited ${code}`));
    });
  });
}

async function fingerprint(buffer, ext) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-fpcalc-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const parsed = JSON.parse(await runFpcalc(file));
    if (typeof parsed.duration !== "number" || !parsed.fingerprint) return null;
    return { duration: parsed.duration, fingerprint: parsed.fingerprint };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- AcoustID (mirror src/lib/recognize.ts) ----------------------------------
function joinArtists(artists) {
  if (!artists?.length) return null;
  const joined = artists
    .map((a, i) => a.name + (i < artists.length - 1 ? a.joinphrase ?? "" : ""))
    .join("")
    .trim();
  return joined || null;
}

function pickReleaseGroup(groups) {
  if (!groups?.length) return { album: null, releaseGroupMbid: null };
  const clean = groups.find(
    (g) =>
      g.type === "Album" &&
      !(g.secondarytypes ?? []).some((t) => t.toLowerCase() === "compilation")
  );
  const chosen = clean ?? groups[0];
  return {
    album: chosen.title?.trim() || null,
    releaseGroupMbid: chosen.id ?? null,
  };
}

async function lookupAcoustId(fp) {
  if (!ACOUSTID_KEY) return null;
  try {
    await acoustidLimiter.wait();
    const url = new URL(ACOUSTID_ENDPOINT);
    url.searchParams.set("client", ACOUSTID_KEY);
    url.searchParams.set("duration", String(Math.round(fp.duration)));
    url.searchParams.set("fingerprint", fp.fingerprint);
    url.searchParams.set("meta", "recordings releasegroups compress");
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "ok" || !data.results?.length) return null;
    const best = data.results.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score < MIN_SCORE) return null;
    const rec = (best.recordings ?? []).find(
      (r) => r.artists?.length || r.releasegroups?.length
    );
    if (!rec) return null;
    return {
      artist: joinArtists(rec.artists),
      ...pickReleaseGroup(rec.releasegroups),
    };
  } catch {
    return null;
  }
}

// --- art: Cover Art Archive, then iTunes (mirror src/lib/recognize.ts) -------
async function coverArtArchive(mbid) {
  await acoustidLimiter.wait();
  return downloadImage(`${CAA_ENDPOINT}/release-group/${mbid}/front-500`);
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

async function findArtByTags(q) {
  if (!q.artist) return null;
  const want = normalize(q.artist);
  const terms = [`${q.artist} ${q.title}`.trim()];
  if (q.album) terms.push(`${q.artist} ${q.album}`.trim());
  for (const term of terms) {
    try {
      const url = await itunesArtUrl(term, want);
      if (url) {
        const img = await downloadImage(url);
        if (img) return { ...img, source: "itunes", ref: url };
      }
    } catch {
      // try the next term
    }
  }
  return null;
}

async function resolveArt(q) {
  if (q.mbid) {
    const art = await coverArtArchive(q.mbid);
    if (art) return { ...art, source: "coverartarchive", ref: q.mbid };
  }
  return findArtByTags(q);
}

// --- thumbnail ---------------------------------------------------------------
function runThumbFfmpeg(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-nostats", "-i", inputPath,
        "-vf", `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=decrease`,
        "-frames:v", "1", "-q:v", "3", "-f", "mjpeg", "-",
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
        : reject(new Error(`ffmpeg thumbnail exited ${code}`));
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
    const out = await runThumbFfmpeg(file);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function putObject(key, body, contentType) {
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType })
  );
}

// --- main --------------------------------------------------------------------
const limitSql = LIMIT ? ` limit ${LIMIT}` : "";
const { rows } = await pool.query(
  `select id, owner_id, s3_key, title, artist, album, art_s3_key from tracks
    where artist is null or album is null or art_s3_key is null
    order by created_at` + limitSql
);

console.log(
  `recognize-missing-metadata — ${APPLY ? "APPLY" : "DRY-RUN"}${LIMIT ? ` | limit ${LIMIT}` : ""} | ` +
    `${ACOUSTID_KEY ? "AcoustID enabled" : "no ACOUSTID_API_KEY (art-fallback only)"}`
);
if (!APPLY) console.log(`(dry-run: no S3/DB writes; proposals -> ${REVIEW_LOG})`);
console.log(`${rows.length} track(s) with a missing artist/album/art.`);

let filledArtist = 0,
  filledAlbum = 0,
  filledArt = 0,
  miss = 0,
  failed = 0,
  processed = 0;

for (const row of rows) {
  try {
    const needArtist = !row.artist;
    const needAlbum = !row.album;
    const needArt = !row.art_s3_key;

    let rec = null;
    if (ACOUSTID_KEY) {
      const controller = new AbortController();
      const buffer = await withTimeout(
        downloadObject(row.s3_key, controller.signal),
        120_000,
        () => controller.abort()
      );
      const ext = row.s3_key.split(".").pop()?.toLowerCase() ?? "bin";
      const fp = await fingerprint(buffer, ext);
      if (fp) rec = await lookupAcoustId(fp);
    }

    const newArtist = needArtist && rec?.artist ? rec.artist : null;
    const newAlbum = needAlbum && rec?.album ? rec.album : null;
    const art = needArt
      ? await resolveArt({
          mbid: rec?.releaseGroupMbid ?? null,
          artist: rec?.artist ?? row.artist,
          album: rec?.album ?? row.album,
          title: row.title,
        })
      : null;

    if (!newArtist && !newAlbum && !art) {
      miss++;
      if (++processed % 25 === 0) console.log(`  … ${processed}/${rows.length}`);
      continue;
    }

    if (APPLY) {
      const newVals = {};
      if (newArtist) {
        await pool.query(
          `update tracks set artist = $1 where id = $2 and artist is null`,
          [newArtist, row.id]
        );
        newVals.artist = newArtist;
        filledArtist++;
      }
      if (newAlbum) {
        await pool.query(
          `update tracks set album = $1 where id = $2 and album is null`,
          [newAlbum, row.id]
        );
        newVals.album = newAlbum;
        filledAlbum++;
      }
      if (art) {
        const artKey = `art/${row.owner_id}/${row.id}.${art.kind.ext}`;
        await putObject(artKey, art.body, art.kind.contentType);
        const thumb = await makeThumbnail(art.body, art.kind.ext);
        const thumbKey = thumb ? `art/${row.owner_id}/${row.id}.${THUMBNAIL_EXT}` : null;
        if (thumb) await putObject(thumbKey, thumb, THUMBNAIL_CONTENT_TYPE);
        await pool.query(
          `update tracks set art_s3_key = $1, art_thumb_s3_key = $2 where id = $3 and art_s3_key is null`,
          [artKey, thumbKey, row.id]
        );
        newVals.art_s3_key = artKey;
        newVals.art_thumb_s3_key = thumbKey;
        filledArt++;
      }
      const oldVals = Object.fromEntries(Object.keys(newVals).map((k) => [k, null]));
      await revert({ id: row.id, old: oldVals, new: newVals });
      console.log(
        `  ${row.id} — ${[newArtist && "artist", newAlbum && "album", art && `art(${art.source})`].filter(Boolean).join(", ")}`
      );
    } else {
      if (newArtist) filledArtist++;
      if (newAlbum) filledAlbum++;
      if (art) filledArt++;
      await review({
        id: row.id,
        title: row.title,
        artist: newArtist,
        album: newAlbum,
        art: art ? { source: art.source, ref: art.ref, ext: art.kind.ext } : null,
      });
      console.log(
        `  ${row.id} — ${[newArtist && `artist="${newArtist}"`, newAlbum && `album="${newAlbum}"`, art && `art(${art.source})`].filter(Boolean).join(", ")} (dry-run)`
      );
    }
  } catch (err) {
    failed++;
    console.warn(`  ${row.id} — failed: ${err.message}`);
  }
  if (++processed % 25 === 0) console.log(`  … ${processed}/${rows.length}`);
}

console.log(
  `Done${APPLY ? "" : " (dry-run)"}. artist: ${filledArtist}, album: ${filledAlbum}, art: ${filledArt}, no match: ${miss}, failed: ${failed}.`
);
await pool.end();
