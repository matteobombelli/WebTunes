import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  playlists,
  playlistTracks,
  tracks,
  users,
  type Playlist,
} from "@/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { toTrackDTO } from "@/lib/tracks";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";

export async function toPlaylistDTO(
  playlist: Playlist,
  trackCount?: number
): Promise<PlaylistDTO> {
  let coverUrl: string | null = null;
  if (playlist.coverS3Key) {
    coverUrl = (await getPresignedGetUrl(playlist.coverS3Key)).url;
  }
  return {
    id: playlist.id,
    ownerId: playlist.ownerId,
    name: playlist.name,
    coverS3Key: playlist.coverS3Key,
    coverUrl,
    trackCount,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
  };
}

/** Loads a playlist only if it belongs to the given user. */
export async function getOwnPlaylist(playlistId: string, userId: string) {
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist || playlist.ownerId !== userId) return null;
  return playlist;
}

/** A user's playlists with track counts, most recently updated first. */
export async function listPlaylistsWithCount(
  userId: string
): Promise<PlaylistDTO[]> {
  const rows = await db
    .select({
      playlist: playlists,
      trackCount: sql<number>`(select count(*)::int from ${playlistTracks}
        where ${playlistTracks.playlistId} = ${playlists.id})`,
    })
    .from(playlists)
    .where(eq(playlists.ownerId, userId))
    .orderBy(desc(playlists.updatedAt));
  return Promise.all(rows.map((r) => toPlaylistDTO(r.playlist, r.trackCount)));
}

/**
 * A playlist's tracks in order. A friend's track that has since been made
 * private is hidden entirely.
 */
export async function getPlaylistTracks(
  playlistId: string,
  userId: string
): Promise<TrackDTO[]> {
  const rows = await db
    .select({ track: tracks, ownerName: users.name })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        eq(playlistTracks.playlistId, playlistId),
        or(eq(tracks.ownerId, userId), eq(tracks.isPrivate, false))
      )
    )
    .orderBy(asc(playlistTracks.position));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}
