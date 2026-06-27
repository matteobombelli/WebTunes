// Backfill missing cover art / artist / album using ONLINE lookup, for tracks
// whose stored file has no usable embedded tags (the existing
// scripts/backfill-metadata.mjs only recovers what's still embedded). Three
// phases, run in order unless --phase selects one:
//   reextract   — local: a few tracks have embedded art that was never pulled
//                 at upload; recover it cheaply before any network call.
//   art         — iTunes Search (no key): cover art for tracks that already
//                 have artist+album but no art.
//   fingerprint — Chromaprint fpcalc + AcoustID: identify fully-untagged tracks
//                 (artist+album+art all null), then fill artist/album + art.
//
//   node scripts/backfill-online-metadata.mjs [--phase=reextract|art|fingerprint] [--apply] [--limit=N]
//
// Default is DRY-RUN: performs the network reads (proposals are real) but does
// NO S3 puts and NO DB updates — each proposal is appended to
// backfill-online-review.jsonl for eyeballing. --apply performs the writes and
// logs old->new to backfill-online-revert.jsonl (both files are append-only).
//
// Requires fpcalc on PATH (libchromaprint-tools) and ACOUSTID_API_KEY for the
// fingerprint phase; without the key that phase is skipped (best-effort).
// DATABASE_URL + S3_* + ACOUSTID_API_KEY + METADATA_CONTACT_EMAIL come from the
// process env when set, otherwise from the first env file present. Mirrors
// scripts/backfill-metadata.mjs and src/lib/metadata-lookup.ts (keep in sync).
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

const ACOUSTID_API_KEY = env.ACOUSTID_API_KEY;
const UA = `WebTunes/0.1 ( ${env.METADATA_CONTACT_EMAIL || "personal project"} )`;

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const phaseArg = argv.find((a) => a.startsWith("--phase="))?.split("=")[1];
const limitArg = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;
const ALL_PHASES = ["reextract", "art", "fingerprint"];
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
const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";
const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const CAA_BASE = "https://coverartarchive.org";
const SCORE_THRESHOLD = 0.85;
const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;
const FPCALC_TIMEOUT_MS = 30_000;

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

// --- polite per-host rate limiters (the key deviation from the 8-worker pool;
//     external APIs would ban an 8-wide fan-out) ------------------------------
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
const itunesLimiter = new Limiter(3100); // ~20/min
const acoustidLimiter = new Limiter(350); // ~3/s, polite
const caaLimiter = new Limiter(1100); // 1/s

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
      redirect: "follow",
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

// Returns { body, kind, source, url } | null. Tries iTunes (title then album),
// then CAA by release-group MBID.
async function findArt(q) {
  if (q.artist) {
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
        // try the next term / CAA
      }
    }
  }
  if (q.releaseGroupMbid) {
    await caaLimiter.wait();
    const url = `${CAA_BASE}/release-group/${q.releaseGroupMbid}/front-500`;
    const img = await downloadImage(url);
    if (img) return { ...img, source: "caa", url };
  }
  return null;
}

function runFpcalc(path) {
  return new Promise((resolve) => {
    const proc = spawn("fpcalc", ["-json", path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), FPCALC_TIMEOUT_MS);
    proc.on("error", () => (clearTimeout(timer), resolve(null))); // not installed
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const { duration, fingerprint } = JSON.parse(stdout);
        resolve(
          typeof duration === "number" && typeof fingerprint === "string"
            ? { duration, fingerprint }
            : null
        );
      } catch {
        resolve(null);
      }
    });
  });
}

function pickAcoustidResult(data) {
  const results = (data.results ?? [])
    .filter((r) => typeof r.score === "number")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const result of results) {
    if ((result.score ?? 0) < SCORE_THRESHOLD) break;
    for (const rec of result.recordings ?? []) {
      const title = rec.title?.trim();
      const artist = rec.artists?.[0]?.name?.trim();
      if (!title || !artist) continue;
      const rg =
        rec.releasegroups?.find((g) => g.type === "Album") ??
        rec.releasegroups?.[0];
      return {
        title,
        artist,
        album: rg?.title?.trim() || null,
        releaseGroupMbid: rg?.id,
      };
    }
  }
  return null;
}

async function acoustidLookup(buffer, ext) {
  let dir = null;
  let fp = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-fpcalc-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    fp = await runFpcalc(file);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!fp) return null;
  await acoustidLimiter.wait();
  const res = await fetch(ACOUSTID_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      client: ACOUSTID_API_KEY,
      duration: String(Math.round(fp.duration)),
      fingerprint: fp.fingerprint,
      meta: "recordings releasegroups",
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return pickAcoustidResult(await res.json());
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

// --- Phase 2: identify fully-untagged tracks via fpcalc + AcoustID (serial) --
async function phaseFingerprint() {
  if (!ACOUSTID_API_KEY) {
    console.log(`\n[fingerprint] skipped — ACOUSTID_API_KEY not set.`);
    return;
  }
  const { rows } = await pool.query(
    `select id, owner_id, s3_key, title from tracks
      where artist is null and album is null and art_s3_key is null
      order by created_at` + limitSql
  );
  console.log(`\n[fingerprint] ${rows.length} fully-untagged track(s) to identify.`);
  let identified = 0,
    miss = 0,
    failed = 0,
    processed = 0;
  for (const { id, owner_id, s3_key, title } of rows) {
    try {
      const controller = new AbortController();
      const buffer = await withTimeout(
        downloadObject(s3_key, controller.signal),
        90_000,
        () => controller.abort()
      );
      const ext = s3_key.split(".").pop()?.toLowerCase() ?? "";
      const idr = await acoustidLookup(buffer, ext);
      if (!idr) {
        miss++;
        console.log(`  ${id} — no confident match`);
        continue;
      }
      const art = await findArt({
        artist: idr.artist,
        album: idr.album,
        title: idr.title,
        releaseGroupMbid: idr.releaseGroupMbid,
      });
      if (APPLY) {
        // Fill the genuinely-missing artist/album (+art); keep the existing
        // filename-derived title (the dry-run logs the proposed title so titles
        // can be normalized as a separate, deliberate step).
        const sets = ["artist = $1"];
        const vals = [idr.artist];
        if (idr.album) {
          vals.push(idr.album);
          sets.push(`album = $${vals.length}`);
        }
        let artKey = null;
        if (art) {
          artKey = await putArt(owner_id, id, art);
          vals.push(artKey);
          sets.push(`art_s3_key = $${vals.length}`);
        }
        vals.push(id);
        await pool.query(
          `update tracks set ${sets.join(", ")} where id = $${vals.length} and artist is null`,
          vals
        );
        await revert({
          phase: "fingerprint",
          id,
          old: { artist: null, album: null, art_s3_key: null },
          new: { artist: idr.artist, album: idr.album, art_s3_key: artKey },
          proposedTitle: idr.title,
        });
        identified++;
        console.log(`  ${id} — ${idr.artist} — ${idr.title}${art ? ` +art(${art.source})` : ""}`);
      } else {
        await review({
          phase: "fingerprint",
          id,
          currentTitle: title,
          proposed: { artist: idr.artist, album: idr.album, title: idr.title },
          art: art ? { source: art.source, url: art.url, ext: art.kind.ext } : null,
        });
        identified++;
        console.log(`  ${id} — ${idr.artist} — ${idr.title}${art ? ` +art(${art.source})` : ""} (dry-run)`);
      }
    } catch (err) {
      failed++;
      console.warn(`  ${id} — failed: ${err.message}`);
    }
    if (++processed % 25 === 0) console.log(`  … ${processed}/${rows.length}`);
  }
  console.log(`[fingerprint] done. ${identified} ${APPLY ? "updated" : "identified (dry-run)"}, ${miss} no match, ${failed} failed.`);
}

console.log(
  `backfill-online-metadata — ${APPLY ? "APPLY" : "DRY-RUN"} | phases: ${PHASES.join(", ")}${LIMIT ? ` | limit ${LIMIT}` : ""}`
);
if (!APPLY) console.log(`(dry-run: no S3/DB writes; proposals -> ${REVIEW_LOG})`);

for (const phase of PHASES) {
  if (phase === "reextract") await phaseReextract();
  else if (phase === "art") await phaseArt();
  else if (phase === "fingerprint") await phaseFingerprint();
}

await pool.end();
