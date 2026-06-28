// IndexedDB mirror of downloaded tracks/playlists so the downloads page can
// render fully offline. Audio bytes live in Cache Storage (see
// audio-cache.ts); this holds only metadata, in the existing DTO shapes.

import type { PlaylistDTO, TrackDTO } from "@/lib/types";

export type DownloadedTrack = TrackDTO & {
  downloadedAt: string;
  /**
   * True when the user downloaded the track directly. Unpinned tracks exist
   * only as members of downloaded playlists and are garbage-collected when
   * no playlist references them anymore.
   */
  pinned: boolean;
};

export type DownloadedPlaylist = PlaylistDTO & {
  /** Track ids in playlist order (the playlist's full contents at sync time). */
  trackIds: string[];
  syncedAt: string;
};

const DB_NAME = "webtunes-offline";
const DB_VERSION = 1;
const TRACKS = "tracks";
const PLAYLISTS = "playlists";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS)) {
        db.createObjectStore(TRACKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS)) {
        db.createObjectStore(PLAYLISTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function getDownloadedTracks(): Promise<DownloadedTrack[]> {
  return asPromise((await store(TRACKS, "readonly")).getAll());
}

export async function getDownloadedTrack(
  id: string
): Promise<DownloadedTrack | undefined> {
  return asPromise((await store(TRACKS, "readonly")).get(id));
}

export async function putDownloadedTrack(track: DownloadedTrack) {
  await asPromise((await store(TRACKS, "readwrite")).put(track));
}

export async function deleteDownloadedTrack(id: string) {
  await asPromise((await store(TRACKS, "readwrite")).delete(id));
}

export async function getDownloadedPlaylists(): Promise<DownloadedPlaylist[]> {
  return asPromise((await store(PLAYLISTS, "readonly")).getAll());
}

export async function putDownloadedPlaylist(playlist: DownloadedPlaylist) {
  await asPromise((await store(PLAYLISTS, "readwrite")).put(playlist));
}

export async function deleteDownloadedPlaylist(id: string) {
  await asPromise((await store(PLAYLISTS, "readwrite")).delete(id));
}

/**
 * Clears all downloaded metadata (both object stores). Used on account switch.
 * Clears in place rather than deleting the database, so the cached open
 * connection — which would otherwise block an indexedDB.deleteDatabase() with
 * `onblocked` — stays valid for the next user's downloads.
 */
export async function clearAll(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([TRACKS, PLAYLISTS], "readwrite");
    tx.objectStore(TRACKS).clear();
    tx.objectStore(PLAYLISTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
