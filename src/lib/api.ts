import { BASE_PATH } from "./base-path";
import type { TrackDTO } from "./types";

// Client-side fetch wrapper. next/link and the router add the basePath
// automatically, but plain fetch() does not — this is the one place that
// knows the prefix.
export async function api<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_PATH}/api${path}`, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Tracks similar to a seed track, for the "play similar" radio. Paginate with a
// growing offset to pull fresh, non-repeating batches; fewer than `limit`
// results means the similar pool is exhausted.
export async function fetchSimilarTracks(
  seedId: string,
  offset: number,
  limit: number
): Promise<TrackDTO[]> {
  const { tracks } = await api<{ tracks: TrackDTO[] }>(
    `/tracks/${seedId}/similar?offset=${offset}&limit=${limit}`
  );
  return tracks;
}

// Stable stream URL for a track (302s to a presigned S3 URL). The service
// worker matches this exact path shape to serve downloaded audio offline.
export function streamSrc(trackId: string): string {
  return `${BASE_PATH}/api/tracks/${trackId}/stream`;
}

// Stable cover-art URL for a track (302s to a presigned S3 URL). The service
// worker matches this exact path shape to serve downloaded art offline.
export function artSrc(trackId: string): string {
  return `${BASE_PATH}/api/tracks/${trackId}/art`;
}
