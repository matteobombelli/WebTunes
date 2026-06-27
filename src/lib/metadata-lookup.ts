import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";
import { imageKindFromBytes, type ImageKind } from "@/lib/image-upload";

// Online metadata recovery for tracks whose audio file carries no usable tags or
// cover art. Two independent, best-effort primitives (no combined orchestrator —
// the upload route and the backfill script compose them differently):
//   - fingerprintAndIdentify: Chromaprint `fpcalc` + AcoustID identify an
//     untagged recording (-> title/artist/album/release-group MBID).
//   - findCoverArt: iTunes Search (no key) with a Cover Art Archive fallback.
// Everything returns null on any failure/miss, exactly like loudness/CLAP/lyrics.
//
// SECURITY: cover art comes from untrusted remote hosts, so the stored kind is
// sniffed from the bytes (imageKindFromBytes), never the URL/Content-Type — the
// offline SW replays stored Content-Type from a same-origin cache (stored XSS).

export type IdResult = {
  title: string;
  artist: string;
  album: string | null;
  releaseGroupMbid?: string;
};
export type CoverArt = { body: Buffer; kind: ImageKind };

const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";
const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const CAA_BASE = "https://coverartarchive.org";
const SCORE_THRESHOLD = 0.85; // AcoustID acoustic-match confidence (0..1)
const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;
const FPCALC_TIMEOUT_MS = 30_000;

// MusicBrainz/CAA policy requires a descriptive User-Agent with a contact.
function userAgent(): string {
  return `WebTunes/0.1 ( ${process.env.METADATA_CONTACT_EMAIL || "personal project"} )`;
}

// --- fingerprint + identify --------------------------------------------------

function runFpcalc(
  path: string
): Promise<{ duration: number; fingerprint: string } | null> {
  return new Promise((resolve) => {
    const proc = spawn("fpcalc", ["-json", path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), FPCALC_TIMEOUT_MS);
    // ENOENT when fpcalc (libchromaprint-tools) isn't installed — degrade to null.
    proc.on("error", () => (clearTimeout(timer), resolve(null)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const { duration, fingerprint } = JSON.parse(stdout);
        if (typeof duration === "number" && typeof fingerprint === "string") {
          resolve({ duration, fingerprint });
        } else resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

type AcoustidResponse = {
  results?: {
    score?: number;
    recordings?: {
      title?: string;
      artists?: { name?: string }[];
      releasegroups?: { id?: string; title?: string; type?: string }[];
    }[];
  }[];
};

function pickAcoustidResult(data: AcoustidResponse): IdResult | null {
  const results = (data.results ?? [])
    .filter((r) => typeof r.score === "number")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const result of results) {
    if ((result.score ?? 0) < SCORE_THRESHOLD) break;
    for (const rec of result.recordings ?? []) {
      const title = rec.title?.trim();
      const artist = rec.artists?.[0]?.name?.trim();
      if (!title || !artist) continue;
      // Prefer an Album release-group for the album name + a stable cover.
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

/**
 * Identify an untagged file via fpcalc + AcoustID. Returns null when
 * ACOUSTID_API_KEY is unset, fpcalc is missing, or no result clears the
 * confidence threshold. fpcalc runs under the ffmpeg gate (it links the same
 * native decode libs), so concurrent uploads can't oversubscribe CPU.
 */
export async function fingerprintAndIdentify(
  buffer: Buffer,
  ext: string
): Promise<IdResult | null> {
  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) return null;

  const fp = await withFfmpeg(async () => {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "wt-fpcalc-"));
      const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "bin";
      const file = join(dir, `${randomUUID()}.${safeExt}`);
      await writeFile(file, buffer);
      return await runFpcalc(file);
    } catch {
      return null;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  if (!fp) return null;

  try {
    const res = await fetch(ACOUSTID_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent(),
      },
      body: new URLSearchParams({
        client: apiKey,
        duration: String(Math.round(fp.duration)),
        fingerprint: fp.fingerprint,
        meta: "recordings releasegroups",
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return pickAcoustidResult((await res.json()) as AcoustidResponse);
  } catch {
    return null;
  }
}

// --- cover art ---------------------------------------------------------------

/** Normalize an artist/album for fuzzy comparison (case/diacritics/qualifiers). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "") // strip combining diacritics
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "") // drop "(Deluxe)" / "[Explicit]"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function downloadImage(url: string): Promise<CoverArt | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent() },
      redirect: "follow", // CAA 307-redirects to archive.org
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ART_BYTES) return null;
    const kind = imageKindFromBytes(buf); // never trust the remote type
    return kind ? { body: buf, kind } : null;
  } catch {
    return null;
  }
}

// One iTunes Search call; returns an upscaled artwork URL for the first result
// whose artist matches, or null.
async function itunesArtUrl(term: string, wantArtist: string): Promise<string | null> {
  const url = new URL(ITUNES_ENDPOINT);
  url.searchParams.set("term", term);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "5");
  url.searchParams.set("country", "US");
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: { artistName?: string; artworkUrl100?: string }[];
  };
  const match = (data.results ?? []).find((r) => {
    if (!r.artworkUrl100 || !r.artistName) return false;
    const got = normalize(r.artistName);
    return got === wantArtist || got.includes(wantArtist); // tolerate "X feat. Y"
  });
  // Upscale the thumbnail by string-swapping the size segment.
  return match?.artworkUrl100?.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1") ?? null;
}

async function findCoverArtItunes(q: {
  artist: string;
  album: string | null;
  title: string;
}): Promise<CoverArt | null> {
  const want = normalize(q.artist);
  // Title first — it's the actual song name; albums can be junk ("Royalty
  // Free"). Fall back to the album term.
  const terms = [`${q.artist} ${q.title}`.trim()];
  if (q.album) terms.push(`${q.artist} ${q.album}`.trim());
  for (const term of terms) {
    try {
      const url = await itunesArtUrl(term, want);
      if (url) {
        const img = await downloadImage(url);
        if (img) return img;
      }
    } catch {
      // try the next term
    }
  }
  return null;
}

/**
 * Find cover art for a track. Tries iTunes (no key) first whenever an artist is
 * known, then Cover Art Archive by release-group MBID (from a fingerprint
 * match). Returns null when nothing usable is found.
 */
export async function findCoverArt(q: {
  artist: string;
  album: string | null;
  title: string;
  releaseGroupMbid?: string;
}): Promise<CoverArt | null> {
  if (q.artist) {
    const art = await findCoverArtItunes(q);
    if (art) return art;
  }
  if (q.releaseGroupMbid) {
    const art = await downloadImage(
      `${CAA_BASE}/release-group/${q.releaseGroupMbid}/front-500`
    );
    if (art) return art;
  }
  return null;
}
