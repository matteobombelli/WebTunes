import { log } from "@/lib/log";

const ROOT = "https://api.listenbrainz.org/1";
const USER_AGENT = "WebTunes/0.1 (personal project)";
const TIMEOUT_MS = 15_000;
const LOOKUP_BATCH_SIZE = 50;
const POPULARITY_RETRY_MS = 30 * 60 * 1000;
let nextRequestAt = 0;
let popularityRetryAt = 0;

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

type TaggedRecording = {
  trackId: string;
  title: string;
  artist: string;
  album: string | null;
};

export type TaggedRecordingIdentity = {
  trackId: string;
  recordingMbid: string;
  artistMbids: string[];
  releaseGroupMbid: string | null;
};

type LookupRow = {
  recording_mbid?: unknown;
  recording_name?: unknown;
  artist_mbids?: unknown;
  artist_credit_name?: unknown;
  release_group_mbid?: unknown;
  metadata?: {
    release?: { release_group_mbid?: unknown };
  };
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordDice(left: string, right: string): number {
  const a = new Set(left.split(" ").filter(Boolean));
  const b = new Set(right.split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return (2 * common) / (a.size + b.size);
}

function metadataAgrees(
  requested: string,
  returned: unknown,
  minimumDice: number
): boolean {
  if (typeof returned !== "string") return false;
  const want = normalizeLookupText(requested);
  const got = normalizeLookupText(returned);
  if (!want || !got) return false;
  if (want === got) return true;
  // Covers harmless credit differences such as "Beatles" / "The Beatles".
  if (` ${want} `.includes(` ${got} `) || ` ${got} `.includes(` ${want} `)) {
    return true;
  }
  return wordDice(want, got) >= minimumDice;
}

export function hasListenBrainzToken(): boolean {
  return Boolean(process.env.LISTENBRAINZ_TOKEN?.trim());
}

/** Resolve already-tagged tracks without reading their audio. ListenBrainz's
 * mapper handles the MusicBrainz search in one authenticated batch; results
 * are still checked against the submitted title/artist before persistence.
 * Null entries are genuine lookup misses and are safe AcoustID fallbacks. */
export async function lookupTaggedRecordingIdentities(
  recordings: TaggedRecording[]
): Promise<Array<TaggedRecordingIdentity | null>> {
  if (!recordings.length) return [];
  const token = process.env.LISTENBRAINZ_TOKEN?.trim();
  if (!token) throw new Error("LISTENBRAINZ_TOKEN is not configured");

  const resolved: Array<TaggedRecordingIdentity | null> = [];
  for (let offset = 0; offset < recordings.length; offset += LOOKUP_BATCH_SIZE) {
    const batch = recordings.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const response = await politeFetch("/metadata/lookup/", {
      method: "POST",
      headers: { Authorization: `Token ${token}` },
      body: JSON.stringify({
        recordings: batch.map((recording) => ({
          recording_name: recording.title,
          artist_name: recording.artist,
          ...(recording.album ? { release_name: recording.album } : {}),
        })),
      }),
    });
    const body: unknown = await response.json();
    const rows = Array.isArray(body)
      ? body
      : body &&
          typeof body === "object" &&
          Array.isArray((body as { recordings?: unknown }).recordings)
        ? (body as { recordings: unknown[] }).recordings
        : [];
    if (rows.length !== batch.length) {
      throw new Error("ListenBrainz returned an unexpected lookup response");
    }

    for (let index = 0; index < batch.length; index++) {
      const raw = rows[index];
      if (!raw || typeof raw !== "object") {
        resolved.push(null);
        continue;
      }
      const row = raw as LookupRow;
      const artistMbids = Array.isArray(row.artist_mbids)
        ? row.artist_mbids.filter(
            (value): value is string =>
              typeof value === "string" && UUID.test(value)
          )
        : [];
      if (
        typeof row.recording_mbid !== "string" ||
        !UUID.test(row.recording_mbid) ||
        !artistMbids.length ||
        !metadataAgrees(batch[index].title, row.recording_name, 0.88) ||
        !metadataAgrees(batch[index].artist, row.artist_credit_name, 0.8)
      ) {
        resolved.push(null);
        continue;
      }
      const releaseGroup =
        typeof row.release_group_mbid === "string"
          ? row.release_group_mbid
          : row.metadata?.release?.release_group_mbid;
      resolved.push({
        trackId: batch[index].trackId,
        recordingMbid: row.recording_mbid,
        artistMbids,
        releaseGroupMbid:
          typeof releaseGroup === "string" && UUID.test(releaseGroup)
            ? releaseGroup
            : null,
      });
    }
  }
  return resolved;
}

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

async function popularForArtist(artistMbid: string): Promise<PopularRecording[]> {
  if (Date.now() < popularityRetryAt) return [];
  try {
    const response = await politeFetch(
      `/popularity/top-recordings-for-artist/${artistMbid}`
    );
    return (await response.json()) as PopularRecording[];
  } catch (error) {
    // ListenBrainz periodically disables this endpoint under high load. It is
    // an optional familiar-track source, so open a short process-wide circuit
    // and let LB Radio keep Suggested Imports working without log floods.
    popularityRetryAt = Date.now() + POPULARITY_RETRY_MS;
    log.warn(
      "suggested-imports",
      "ListenBrainz popularity unavailable; using radio-only suggestions",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

async function radioForArtist(artistMbid: string): Promise<{
  recordings: RadioRecording[];
  metadata: Map<string, MetadataValue>;
}> {
  try {
    const radioParams = new URLSearchParams({
      mode: "medium",
      max_similar_artists: "6",
      max_recordings_per_artist: "4",
      pop_begin: "10",
      pop_end: "90",
    });
    const response = await politeFetch(
      `/lb-radio/artist/${artistMbid}?${radioParams}`
    );
    const raw: unknown = await response.json();
    const recordings: RadioRecording[] = [];
    collectRadio(raw, recordings);
    const ids = [
      ...new Set(recordings.flatMap((row) => row.recording_mbid ?? [])),
    ];
    return {
      recordings,
      metadata: await metadataFor(ids.slice(0, 100)),
    };
  } catch (error) {
    log.warn(
      "suggested-imports",
      `ListenBrainz radio failed for ${artistMbid}`,
      error instanceof Error ? error.message : String(error)
    );
    return { recordings: [], metadata: new Map() };
  }
}

/** Balanced candidate set for one seed artist: popular/deeper recordings by
 * the artist plus medium-mode LB Radio recordings from related artists. */
export async function candidatesForArtist(seed: {
  artistMbid: string;
  artistName: string;
  weight: number;
}): Promise<SuggestedCandidate[]> {
  const popular = await popularForArtist(seed.artistMbid);
  const { recordings: radio, metadata } = await radioForArtist(seed.artistMbid);

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
}
