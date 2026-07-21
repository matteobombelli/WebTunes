import { log } from "@/lib/log";

const ROOT = "https://api.listenbrainz.org/1";
const USER_AGENT = "WebTunes/0.1 (personal project)";
const TIMEOUT_MS = 15_000;
let nextRequestAt = 0;

export type SuggestedCandidate = {
  recordingMbid: string;
  artistMbid: string | null;
  releaseGroupMbid: string | null;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  artUrl: string;
  reason: string;
  related: boolean;
  score: number;
};

type PopularRecording = {
  recording_mbid?: string;
  recording_name?: string;
  artist_name?: string;
  artist_mbids?: string[];
  release_name?: string;
  release_group_mbid?: string;
  length?: number;
  total_listen_count?: number;
};

type RadioRecording = {
  recording_mbid?: string;
  similar_artist_mbid?: string;
  similar_artist_name?: string;
  total_listen_count?: number;
};

async function politeFetch(path: string, init?: RequestInit): Promise<Response> {
  const wait = nextRequestAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + 350;
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", USER_AGENT);
  if (init?.body) headers.set("Content-Type", "application/json");
  let response = await fetch(`${ROOT}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429) {
    const retry = Math.min(
      30_000,
      Math.max(1_000, Number(response.headers.get("retry-after") ?? 2) * 1000)
    );
    await new Promise((resolve) => setTimeout(resolve, retry));
    response = await fetch(`${ROOT}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  if (!response.ok) {
    throw new Error(`ListenBrainz returned ${response.status}`);
  }
  return response;
}

function collectRadio(value: unknown, out: RadioRecording[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRadio(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as RadioRecording;
  if (typeof row.recording_mbid === "string") out.push(row);
  for (const nested of Object.values(value)) collectRadio(nested, out);
}

type MetadataValue = {
  artist?: {
    name?: string;
    artists?: { artist_mbid?: string; name?: string }[];
  };
  recording?: { name?: string; length?: number };
  release?: { name?: string; release_group_mbid?: string };
};

async function metadataFor(
  mbids: string[]
): Promise<Map<string, MetadataValue>> {
  if (!mbids.length) return new Map();
  const response = await politeFetch("/metadata/recording/", {
    method: "POST",
    body: JSON.stringify({ recording_mbids: mbids, inc: "artist release" }),
  });
  const body = (await response.json()) as Record<string, MetadataValue>;
  return new Map(Object.entries(body));
}

/** Balanced candidate set for one seed artist: popular/deeper recordings by
 * the artist plus medium-mode LB Radio recordings from related artists. */
export async function candidatesForArtist(seed: {
  artistMbid: string;
  artistName: string;
  weight: number;
}): Promise<SuggestedCandidate[]> {
  try {
    const popularResponse = await politeFetch(
      `/popularity/top-recordings-for-artist/${seed.artistMbid}`
    );
    const popular = (await popularResponse.json()) as PopularRecording[];

    const radioParams = new URLSearchParams({
      mode: "medium",
      max_similar_artists: "6",
      max_recordings_per_artist: "4",
      pop_begin: "10",
      pop_end: "90",
    });
    const radioResponse = await politeFetch(
      `/lb-radio/artist/${seed.artistMbid}?${radioParams}`
    );
    const radioRaw: unknown = await radioResponse.json();
    const radio: RadioRecording[] = [];
    collectRadio(radioRaw, radio);
    const radioIds = [...new Set(radio.flatMap((r) => r.recording_mbid ?? []))];
    const metadata = await metadataFor(radioIds.slice(0, 100));

    const familiar = popular.slice(0, 30).flatMap((row, index) => {
      if (!row.recording_mbid || !row.recording_name || !row.artist_name) return [];
      return [{
        recordingMbid: row.recording_mbid,
        artistMbid: row.artist_mbids?.[0] ?? seed.artistMbid,
        releaseGroupMbid: row.release_group_mbid ?? null,
        title: row.recording_name,
        artist: row.artist_name,
        album: row.release_name ?? "",
        durationSec: row.length ? Math.round(row.length / 1000) : 0,
        artUrl: "",
        reason: `Because you listen to ${seed.artistName}`,
        related: false,
        score: seed.weight * 2 + 1 / (index + 1),
      } satisfies SuggestedCandidate];
    });

    const related = radio.flatMap((row, index) => {
      if (!row.recording_mbid) return [];
      const meta = metadata.get(row.recording_mbid);
      const title = meta?.recording?.name;
      const artist = meta?.artist?.name ?? row.similar_artist_name;
      if (!title || !artist) return [];
      return [{
        recordingMbid: row.recording_mbid,
        artistMbid:
          meta?.artist?.artists?.[0]?.artist_mbid ??
          row.similar_artist_mbid ??
          null,
        releaseGroupMbid: meta?.release?.release_group_mbid ?? null,
        title,
        artist,
        album: meta?.release?.name ?? "",
        durationSec: meta?.recording?.length
          ? Math.round(meta.recording.length / 1000)
          : 0,
        artUrl: "",
        reason: `Similar to ${seed.artistName}`,
        related: true,
        score:
          seed.weight +
          Math.log10(Math.max(1, row.total_listen_count ?? 1)) / 10 -
          index / 1000,
      } satisfies SuggestedCandidate];
    });
    return [...familiar, ...related];
  } catch (error) {
    log.warn(
      "suggested-imports",
      `ListenBrainz lookup failed for ${seed.artistMbid}`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}
