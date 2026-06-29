import { imageKindFromBytes, type ImageKind } from "@/lib/image-upload";
import { log } from "@/lib/log";

// Online cover-art lookup for tracks whose audio file has no embedded art.
// Best-effort like loudness/lyrics — returns null on any miss.
//
// SECURITY: cover art comes from untrusted remote hosts, so the stored kind is
// sniffed from the bytes (imageKindFromBytes), never the URL/Content-Type — the
// offline SW replays stored Content-Type from a same-origin cache (stored XSS).

export type CoverArt = { body: Buffer; kind: ImageKind };

const ITUNES_ENDPOINT = "https://itunes.apple.com/search";
const MAX_ART_BYTES = 5 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 8000;
const USER_AGENT = "WebTunes/0.1 (personal project)";

/** Normalize an artist for fuzzy comparison (case/diacritics/qualifiers). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function downloadImage(url: string): Promise<CoverArt | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
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
async function itunesArtUrl(
  term: string,
  wantArtist: string
): Promise<string | null> {
  const url = new URL(ITUNES_ENDPOINT);
  url.searchParams.set("term", term);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "5");
  url.searchParams.set("country", "US");
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
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
  return (
    match?.artworkUrl100?.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1") ??
    null
  );
}

/**
 * Find cover art for a track via the iTunes Search API (no key). Searches by
 * title first (the actual song name; albums can be junk like "Royalty Free"),
 * then by album. Returns null when nothing usable is found.
 */
export async function findCoverArt(q: {
  artist: string;
  album: string | null;
  title: string;
}): Promise<CoverArt | null> {
  if (!q.artist) return null;
  const want = normalize(q.artist);
  const terms = [`${q.artist} ${q.title}`.trim()];
  if (q.album) terms.push(`${q.artist} ${q.album}`.trim());
  for (const term of terms) {
    try {
      const url = await itunesArtUrl(term, want);
      if (url) {
        const img = await downloadImage(url);
        if (img) return img;
      }
    } catch (err) {
      // try the next term ("no art found" is normal — gated debug only)
      log.debug(
        "cover",
        `iTunes lookup failed for "${term}"`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return null;
}
