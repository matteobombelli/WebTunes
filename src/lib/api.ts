import { BASE_PATH } from "./base-path";
import { log } from "./log";
import type { TrackDTO } from "./types";

// Client-side fetch wrapper. next/link and the router add the basePath
// automatically, but plain fetch() does not — this is the one place that
// knows the prefix.
//
// REDACTION: this is the chokepoint for nearly all client API traffic, including
// login/register/password-reset POSTs whose bodies carry passwords and tokens.
// We log ONLY method, path (UUIDs — safe), status, duration, and the
// already-user-facing `error` string — NEVER init.body, headers, or response JSON.
export async function api<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const method = init?.method ?? "GET";
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_PATH}/api${path}`, init);
  } catch (err) {
    // Network/abort: server unreachable, offline, or a superseded request the
    // caller aborted. Aborts are routine (e.g. PlaylistBrowser) — don't shout.
    const ms = Math.round(performance.now() - t0);
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      log.error(
        "api",
        `${method} ${path} network error (${ms}ms)`,
        err instanceof Error ? err.message : String(err)
      );
    }
    throw err;
  }
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      // non-JSON error body
    }
    log.warn("api", `${method} ${path} → ${res.status} (${ms}ms)`, message);
    throw new Error(message);
  }
  log.debug("api", `${method} ${path} → ${res.status} (${ms}ms)`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Tracks similar to a seed track, for the "play similar" radio. Pass the
// already-served ids in `excludeIds` to avoid repeats (sampling isn't
// deterministic); fewer than `limit` results means the similar pool is
// exhausted. `withinIds` limits ranking to a candidate set (Discover uses it to
// keep a tapped song's mix inside its section).
export async function fetchSimilarTracks(
  seedId: string,
  excludeIds: string[],
  limit: number,
  withinIds?: string[]
): Promise<TrackDTO[]> {
  const { tracks } = await api<{ tracks: TrackDTO[] }>(
    `/tracks/${seedId}/similar`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excludeIds, limit, withinIds }),
    }
  );
  return tracks;
}

// Stable stream URL for a track (302s to a presigned S3 URL). The service
// worker matches this exact path shape to serve downloaded audio offline.
export function streamSrc(trackId: string): string {
  return `${BASE_PATH}/api/tracks/${trackId}/stream`;
}

// Stable cover-art URL for a track (302s to a presigned S3 URL). The service
// worker matches this exact path shape to serve downloaded art offline. With
// `{ thumb: true }` it requests the downscaled thumbnail (`?v=thumb`); the route
// falls back to the full art when no thumbnail exists, and the SW falls back to
// the cached full art offline, so the thumb URL is always safe to request.
export function artSrc(trackId: string, opts?: { thumb?: boolean }): string {
  return `${BASE_PATH}/api/tracks/${trackId}/art${opts?.thumb ? "?v=thumb" : ""}`;
}

// Stable cover URL for a playlist (302s to a presigned S3 URL), mirroring
// artSrc so covers re-sign per request instead of expiring mid-session.
export function playlistCoverSrc(playlistId: string): string {
  return `${BASE_PATH}/api/playlists/${playlistId}/cover`;
}

// Public (no-auth) stream/art URLs for a shared track. Plain <audio>/<img> src
// don't get the basePath the way next/link does, so prepend it here. Used by the
// public /share/[token] listen page.
export function shareStreamSrc(token: string): string {
  return `${BASE_PATH}/api/share/${token}/stream`;
}

export function shareArtSrc(token: string): string {
  return `${BASE_PATH}/api/share/${token}/art`;
}
