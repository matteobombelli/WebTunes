import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withFfmpeg } from "@/lib/ffmpeg-gate";
import { imageKindFromBytes } from "@/lib/image-upload";
import { log } from "@/lib/log";
import { findCoverArt, type CoverArt } from "@/lib/metadata-lookup";

// Acoustic-fingerprint recognition (AcoustID / Chromaprint) for the background
// recognition worker (lib/recognize-queue.ts). Used to fill MISSING
// artist/album/cover-art only — it never writes the DB itself (the worker does
// the conditional, no-overwrite UPDATEs) and never touches the title.
//
// Best-effort, exactly like loudness/CLAP/art: any failure (fpcalc missing,
// undecodable audio, no AcoustID key, no/low-confidence match, network error)
// yields null and nothing is written. Only the compact fingerprint leaves the
// box — never the audio.
//
// SECURITY: cover art comes from untrusted remote hosts (Cover Art Archive /
// iTunes), so the stored image kind is sniffed from the bytes
// (imageKindFromBytes), never the URL/Content-Type — the offline SW replays a
// stored Content-Type from a same-origin cache (stored XSS). Same model as
// lib/metadata-lookup.ts.

const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";
const CAA_ENDPOINT = "https://coverartarchive.org";
const USER_AGENT = "WebTunes/0.1 (personal project)";
const FPCALC_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 8000;
const MAX_ART_BYTES = 5 * 1024 * 1024; // mirror metadata-lookup.ts
// AcoustID score is 0..1 (the fraction of the fingerprint that matched). Below
// this the match is too weak to trust as ground-truth artist/album metadata.
const MIN_SCORE = 0.5;

// AcoustID asks clients to stay under ~3 req/s and Cover Art Archive (served by
// archive.org) likes ≤1 req/s. The recognition queue runs a single worker, so a
// shared min-interval gate is almost always a no-op — but it guarantees we never
// burst even if something else calls in.
let lastRequestAt = 0;
async function politeWait(): Promise<void> {
  const waitMs = lastRequestAt + 350 - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastRequestAt = Date.now();
}

export type Fingerprint = { duration: number; fingerprint: string };

export type Recognition = {
  artist: string | null;
  album: string | null;
  releaseGroupMbid: string | null;
};

/**
 * Compute a Chromaprint acoustic fingerprint via the `fpcalc` CLI (Chromaprint;
 * a runtime dependency on PATH like ffmpeg). fpcalc shells out to ffmpeg to
 * decode, so it runs through the shared ffmpeg gate. Returns null on any failure.
 * @param buffer the raw audio file bytes
 * @param ext    file extension, only used to name the temp file so fpcalc/ffmpeg
 *               pick the right demuxer (e.g. "mp3", "m4a", "flac").
 */
export async function fingerprint(
  buffer: Buffer,
  ext: string
): Promise<Fingerprint | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "wt-fpcalc-"));
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : "bin";
    const file = join(dir, `${randomUUID()}.${safeExt}`);
    await writeFile(file, buffer);
    const stdout = await withFfmpeg(() => runFpcalc(file));
    const parsed = JSON.parse(stdout) as {
      duration?: number;
      fingerprint?: string;
    };
    if (typeof parsed.duration !== "number" || !parsed.fingerprint) return null;
    return { duration: parsed.duration, fingerprint: parsed.fingerprint };
  } catch (err) {
    log.warn(
      "recognize",
      `fingerprint failed (.${ext})`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFpcalc(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("fpcalc", ["-json", inputPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    const timer = setTimeout(() => proc.kill("SIGKILL"), FPCALC_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // e.g. fpcalc not installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`fpcalc exited with code ${code}`));
    });
  });
}

// AcoustID v2 lookup response (only the fields we read). meta=recordings+
// releasegroups returns the MusicBrainz metadata inline, so there is no separate
// MusicBrainz call.
type AcoustIdResponse = {
  status?: string;
  results?: {
    id: string;
    score: number;
    recordings?: {
      id: string;
      title?: string;
      artists?: { id: string; name: string; joinphrase?: string }[];
      releasegroups?: {
        id: string;
        title?: string;
        type?: string;
        secondarytypes?: string[];
      }[];
    }[];
  }[];
};

/**
 * Look up a fingerprint against AcoustID. Returns the recognized artist / album
 * / release-group MBID for the best-scoring match above MIN_SCORE, or null when
 * there is no key, no match, or the match is too weak.
 */
export async function lookupAcoustId(
  fp: Fingerprint
): Promise<Recognition | null> {
  const key = process.env.ACOUSTID_API_KEY;
  if (!key) return null;
  try {
    await politeWait();
    const url = new URL(ACOUSTID_ENDPOINT);
    url.searchParams.set("client", key);
    url.searchParams.set("duration", String(Math.round(fp.duration)));
    url.searchParams.set("fingerprint", fp.fingerprint);
    // Space-separated meta list; `compress` gzips the body (fetch decodes it).
    url.searchParams.set("meta", "recordings releasegroups compress");
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as AcoustIdResponse;
    if (data.status !== "ok" || !data.results?.length) return null;
    const best = data.results.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score < MIN_SCORE) return null;
    const rec = best.recordings?.find(
      (r) => r.artists?.length || r.releasegroups?.length
    );
    if (!rec) return null;
    return {
      artist: joinArtists(rec.artists),
      ...pickReleaseGroup(rec.releasegroups),
    };
  } catch (err) {
    log.warn(
      "recognize",
      "acoustid lookup failed",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/** Join MusicBrainz artist credits honoring each credit's joinphrase. */
function joinArtists(
  artists: { name: string; joinphrase?: string }[] | undefined
): string | null {
  if (!artists?.length) return null;
  const joined = artists
    .map((a, i) => a.name + (i < artists.length - 1 ? a.joinphrase ?? "" : ""))
    .join("")
    .trim();
  return joined || null;
}

/**
 * Choose a release group for album + cover art. Prefer a primary-type "Album"
 * that isn't a compilation (various-artists / "Royalty Free" comps are the
 * common junk match), else fall back to the first release group.
 */
function pickReleaseGroup(
  groups:
    | { id: string; title?: string; type?: string; secondarytypes?: string[] }[]
    | undefined
): { album: string | null; releaseGroupMbid: string | null } {
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

/**
 * Resolve cover art for a recognized (or already-tagged) track: try Cover Art
 * Archive by release-group MBID first, then fall back to the iTunes lookup
 * (findCoverArt) by artist/album/title. Returns null when both miss. The stored
 * kind is sniffed from the bytes, never the remote Content-Type.
 */
export async function resolveArt(q: {
  mbid: string | null;
  artist: string | null;
  album: string | null;
  title: string;
}): Promise<CoverArt | null> {
  if (q.mbid) {
    const art = await coverArtArchive(q.mbid);
    if (art) return art;
  }
  // findCoverArt requires an artist; with none, there's nothing left to try.
  if (q.artist) {
    return findCoverArt({ artist: q.artist, album: q.album, title: q.title });
  }
  return null;
}

async function coverArtArchive(mbid: string): Promise<CoverArt | null> {
  try {
    await politeWait();
    // `front-500` 307-redirects to the image on archive.org; fetch follows it.
    const res = await fetch(`${CAA_ENDPOINT}/release-group/${mbid}/front-500`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null; // 404 when the release group has no front cover
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_ART_BYTES) return null;
    const kind = imageKindFromBytes(body); // never trust the remote type
    return kind ? { body, kind } : null;
  } catch {
    return null; // a miss is normal
  }
}
