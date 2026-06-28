// Download/remove/sync orchestration for offline playback. Pure async
// functions over IndexedDB metadata (db.ts) + Cache Storage audio
// (audio-cache.ts); queueing and UI state live in src/stores/downloads.ts.

import { api } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { deleteArt, hasArt, putArt } from "./art-cache";
import { deleteAudio, hasAudio, hasManyAudio, putAudio } from "./audio-cache";
import {
  clearAll,
  deleteDownloadedPlaylist,
  deleteDownloadedTrack,
  getDownloadedPlaylists,
  getDownloadedTrack,
  getDownloadedTracks,
  putDownloadedPlaylist,
  putDownloadedTrack,
  type DownloadedPlaylist,
} from "./db";

// Every Cache Storage bucket that may hold the signed-in user's audio/art/app
// shell. KEEP IN SYNC with public/sw.js (AUDIO_CACHE / ART_CACHE / PREFETCH /
// SHELL_CACHE) and audio-cache.ts / art-cache.ts.
const OFFLINE_CACHES = ["wt-audio", "wt-art", "wt-prefetch", "wt-shell-v2"];

type PlaylistWithTracks = PlaylistDTO & { tracks: TrackDTO[] };

/**
 * Caches a track's cover art for offline display. Best-effort: a track with no
 * embedded art, or a failed art fetch, just stays online-only for its art.
 */
async function cacheArt(track: TrackDTO): Promise<void> {
  if (!track.artS3Key || (await hasArt(track.id))) return;
  try {
    const { url } = await api<{ url: string }>(`/tracks/${track.id}/art-url`);
    const res = await fetch(url);
    if (!res.ok) return;
    await putArt(track.id, await res.blob());
  } catch {
    // Art is non-essential; never fail a download over it.
  }
}

/**
 * Fetches a track's audio into the offline cache and records its metadata.
 * Already-downloaded tracks are not re-fetched (but get pinned if asked).
 */
export async function downloadTrack(
  track: TrackDTO,
  pin: boolean,
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const existing = await getDownloadedTrack(track.id);
  if (existing && (await hasAudio(track.id))) {
    if (pin && !existing.pinned) {
      await putDownloadedTrack({ ...existing, pinned: true });
    }
    await cacheArt(track); // backfill art for tracks downloaded before this feature
    return;
  }

  // Downloads can't ride the stable /stream URL: the SW intercepts it, and
  // we need a CORS-readable body — so fetch the presigned URL directly.
  const { url } = await api<{ url: string }>(`/tracks/${track.id}/stream-url`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const total =
    Number(res.headers.get("Content-Length")) || track.fileSize || 0;
  let blob: Blob;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
    blob = new Blob(chunks);
  } else {
    blob = await res.blob();
  }

  await putAudio(track.id, blob, track.mimeType);
  await cacheArt(track);
  await putDownloadedTrack({
    ...track,
    downloadedAt: new Date().toISOString(),
    pinned: pin || (existing?.pinned ?? false),
  });
}

/**
 * Records a playlist for offline use and returns the tracks whose audio
 * still needs downloading (the caller queues them).
 */
export async function downloadPlaylist(
  playlistId: string
): Promise<{ playlist: DownloadedPlaylist; toDownload: TrackDTO[] }> {
  const { tracks, ...dto } = await api<PlaylistWithTracks>(
    `/playlists/${playlistId}`
  );
  const playlist: DownloadedPlaylist = {
    ...dto,
    trackIds: tracks.map((t) => t.id),
    syncedAt: new Date().toISOString(),
  };
  await putDownloadedPlaylist(playlist);
  const present = await hasManyAudio(tracks.map((t) => t.id));
  const toDownload = tracks.filter((t) => !present.has(t.id));
  return { playlist, toDownload };
}

/** True if any downloaded playlist (other than `except`) contains the track. */
async function isReferenced(trackId: string, except?: string): Promise<boolean> {
  const playlists = await getDownloadedPlaylists();
  return playlists.some(
    (p) => p.id !== except && p.trackIds.includes(trackId)
  );
}

/**
 * Removes a direct download. The audio stays if a downloaded playlist still
 * references the track (the record just loses its pin).
 */
export async function removeTrack(trackId: string): Promise<void> {
  const existing = await getDownloadedTrack(trackId);
  if (await isReferenced(trackId)) {
    if (existing?.pinned) {
      await putDownloadedTrack({ ...existing, pinned: false });
    }
    return;
  }
  await deleteAudio(trackId);
  await deleteArt(trackId);
  await deleteDownloadedTrack(trackId);
}

/** Drops unpinned, no-longer-referenced former members of a playlist. */
async function collectRemoved(trackIds: string[], playlistId: string) {
  for (const trackId of trackIds) {
    const track = await getDownloadedTrack(trackId);
    if (track?.pinned) continue;
    if (await isReferenced(trackId, playlistId)) continue;
    await deleteAudio(trackId);
    await deleteArt(trackId);
    await deleteDownloadedTrack(trackId);
  }
}

export async function removePlaylist(playlistId: string): Promise<void> {
  const playlists = await getDownloadedPlaylists();
  const playlist = playlists.find((p) => p.id === playlistId);
  if (!playlist) return;
  await deleteDownloadedPlaylist(playlistId);
  await collectRemoved(playlist.trackIds, playlistId);
}

/**
 * Hard-purge ALL offline state — every cache bucket plus the IndexedDB metadata
 * — in one pass. Used when a DIFFERENT account signs in on the same browser
 * profile: the caches and DB are keyed only by track id with no access check, so
 * the previous user's downloads (including private tracks) must not survive the
 * switch. Heavier than removeAll(): it also drops the prefetch/shell caches and
 * clears the stores wholesale instead of per-track.
 */
export async function purgeAllOfflineData(): Promise<void> {
  if (typeof caches !== "undefined") {
    await Promise.all(
      OFFLINE_CACHES.map((c) => caches.delete(c).catch(() => false))
    );
  }
  await clearAll().catch(() => {});
}

/** Wipes every download — playlists and tracks (audio, art, metadata) alike. */
export async function removeAll(): Promise<void> {
  for (const playlist of await getDownloadedPlaylists()) {
    await deleteDownloadedPlaylist(playlist.id);
  }
  for (const track of await getDownloadedTracks()) {
    await deleteAudio(track.id);
    await deleteArt(track.id);
    await deleteDownloadedTrack(track.id);
  }
}

/**
 * Reconciles every downloaded playlist with the server: refreshes metadata
 * and order, garbage-collects tracks that left the playlist, and returns
 * tracks that still need audio (newly added or previously interrupted).
 * Unreachable playlists (deleted server-side, offline, auth) are kept as-is:
 * downloads persist until the user removes them.
 */
export async function syncPlaylists(): Promise<TrackDTO[]> {
  const toDownload = new Map<string, TrackDTO>();
  for (const local of await getDownloadedPlaylists()) {
    let remote: PlaylistWithTracks;
    try {
      remote = await api<PlaylistWithTracks>(`/playlists/${local.id}`);
    } catch {
      continue;
    }
    const { tracks, ...dto } = remote;
    const remoteIds = new Set(tracks.map((t) => t.id));
    await putDownloadedPlaylist({
      ...dto,
      trackIds: tracks.map((t) => t.id),
      syncedAt: new Date().toISOString(),
    });
    await collectRemoved(
      local.trackIds.filter((id) => !remoteIds.has(id)),
      local.id
    );
    const present = await hasManyAudio(tracks.map((t) => t.id));
    for (const track of tracks) {
      if (!present.has(track.id)) toDownload.set(track.id, track);
    }
  }
  return [...toDownload.values()];
}
