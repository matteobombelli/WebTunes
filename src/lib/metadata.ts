import { parseBuffer, type IAudioMetadata } from "music-metadata";

export type TrackMetadata = {
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  lyrics: string | null;
  lyricsSource: "embedded" | "lrclib" | "none";
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
    meta = await parseBuffer(buffer, { mimeType, size: buffer.length });
  } catch {
    // Unparseable tags — fall back to the filename.
  }

  const fallbackTitle = filename.replace(/\.[^.]+$/, "");
  const title = meta?.common.title?.trim() || fallbackTitle;
  const artist = meta?.common.artist?.trim() || null;
  const album = meta?.common.album?.trim() || null;
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

  return { title, artist, album, durationSec, lyrics, lyricsSource };
}
