import { BASE_PATH } from "./base-path";

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

// Stable stream URL for a track (302s to a presigned S3 URL). The service
// worker matches this exact path shape to serve downloaded audio offline.
export function streamSrc(trackId: string): string {
  return `${BASE_PATH}/api/tracks/${trackId}/stream`;
}
