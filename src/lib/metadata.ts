import { parseBuffer, type IAudioMetadata } from "music-metadata";

// Cap embedded cover art before it can reach ffmpeg (lib/thumbnail.ts): a small,
// highly-compressible image that declares huge pixel dimensions decodes to a
// multi-GB frame (a decompression bomb → OOM). The remote-art path enforces the
// same idea (MAX_ART_BYTES in lib/metadata-lookup.ts, 5MB); embedded art is
// allowed a little more headroom for legitimate hi-res covers.
const MAX_EMBEDDED_ART_BYTES = 10 * 1024 * 1024;

// Field caps: no ingest path may store unbounded tag text. A crafted multi-MB
// title/USLT tag would otherwise blow past the 1 MB tsvector limit on the
// search_vector generated column (drizzle/0001) and 500 the upload after the
// S3 objects are already up (orphaning them) — and a merely-huge value ships
// in every list/search payload. 200 matches the web PATCH route's cap.
export const MAX_TAG_CHARS = 200;
export const MAX_LYRICS_CHARS = 100_000;

/** Trim, NFC-normalize (macOS taggers emit NFD, which breaks the
 *  title+artist duplicate detection against NFC copies), and cap a tag
 *  value. Empty/missing → null. */
export function cleanTag(value: string | null | undefined): string | null {
  const trimmed = value?.trim().normalize("NFC");
  if (!trimmed) return null;
  return trimmed.length > MAX_TAG_CHARS ? trimmed.slice(0, MAX_TAG_CHARS) : trimmed;
}

export type TrackMetadata = {
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  lyrics: string | null;
  lyricsSource: "embedded" | "lrclib" | "none";
  /** Embedded cover art, if any. Best-effort; never blocks an upload. */
  artBuffer: Buffer | null;
  artMime: string | null;
};

function embeddedLyrics(meta: IAudioMetadata): string | null {
  const tag = meta.common.lyrics?.[0];
  if (tag) {
    if (typeof tag === "string") return tag;
    if (tag.text) return tag.text;
    if (tag.syncText?.length) {
      return tag.syncText.map((line) => line.text).join("\n");
    }
  }
  // ffmpeg writes lyrics as a TXXX:USLT user-defined frame, which
  // music-metadata does not map into common.lyrics.
  for (const frames of Object.values(meta.native)) {
    for (const frame of frames) {
      if (!/^(TXXX:)?(USLT|LYRICS|UNSYNCEDLYRICS)/i.test(frame.id)) continue;
      const value = frame.value as unknown;
      if (typeof value === "string" && value.trim()) return value.trim();
      if (
        value &&
        typeof value === "object" &&
        "text" in value &&
        typeof value.text === "string" &&
        value.text.trim()
      ) {
        return value.text.trim();
      }
    }
  }
  return null;
}

async function fetchLrclibLyrics(
  artist: string,
  title: string,
  album: string | null,
  durationSec: number | null
): Promise<string | null> {
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
    const data = (await res.json()) as { plainLyrics?: string | null };
    return data.plainLyrics?.trim() || null;
  } catch {
    return null; // lyrics are best-effort; never fail an upload over them
  }
}

export async function extractTrackMetadata(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<TrackMetadata> {
  let meta: IAudioMetadata | null = null;
  try {
    // duration:true makes music-metadata scan to the last page when the
    // header lacks a duration (e.g. Ogg/Opus, whose length lives in the
    // final page's granule position).
    meta = await parseBuffer(
      buffer,
      { mimeType, size: buffer.length },
      { duration: true }
    );
  } catch {
    // Unparseable tags — fall back to the filename.
  }

  const fallbackTitle = filename.replace(/\.[^.]+$/, "");
  const title = cleanTag(meta?.common.title) ?? cleanTag(fallbackTitle) ?? fallbackTitle;
  const artist = cleanTag(meta?.common.artist);
  const album = cleanTag(meta?.common.album);
  const durationSec = meta?.format.duration
    ? Math.round(meta.format.duration)
    : null;

  let lyrics = meta ? embeddedLyrics(meta) : null;
  let lyricsSource: TrackMetadata["lyricsSource"] = lyrics
    ? "embedded"
    : "none";

  if (!lyrics && artist) {
    lyrics = await fetchLrclibLyrics(artist, title, album, durationSec);
    if (lyrics) lyricsSource = "lrclib";
  }
  if (lyrics && lyrics.length > MAX_LYRICS_CHARS) {
    lyrics = lyrics.slice(0, MAX_LYRICS_CHARS);
  }

  const picture = meta?.common.picture?.[0];
  // Drop over-cap art like any other best-effort art failure — the upload still
  // succeeds; it just stores no embedded cover.
  const artBuffer =
    picture?.data && picture.data.byteLength <= MAX_EMBEDDED_ART_BYTES
      ? Buffer.from(picture.data)
      : null;
  const artMime = artBuffer ? (picture?.format ?? null) : null;

  return {
    title,
    artist,
    album,
    durationSec,
    lyrics,
    lyricsSource,
    artBuffer,
    artMime,
  };
}
