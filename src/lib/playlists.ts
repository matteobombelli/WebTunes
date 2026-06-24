import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  playlists,
  playlistTracks,
  tracks,
  users,
  type Playlist,
} from "@/db/schema";
import { areFriends, friendIdsOf } from "@/lib/friends";
import { getPresignedGetUrl } from "@/lib/s3";
import { toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

/** ownerName should be null for the viewer's own playlists. */
export async function toPlaylistDTO(
  playlist: Playlist,
  trackCount?: number,
  ownerName: string | null = null
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
    isPrivate: playlist.isPrivate,
    trackCount,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
    ownerName,
  };
}

/** Loads a playlist only if it belongs to the given user. */
export async function getOwnPlaylist(playlistId: string, userId: string) {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist || playlist.ownerId !== userId) return null;
  return playlist;
}

/**
 * Loads a playlist the user may view: their own, or a non-private playlist
 * owned by an accepted friend. Returns null otherwise. Mutations must still
 * use getOwnPlaylist — this is read access only.
 */
export async function getAccessiblePlaylist(playlistId: string, userId: string) {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist) return null;
  if (playlist.ownerId === userId) return playlist;
  if (playlist.isPrivate) return null;
  if (!(await areFriends(userId, playlist.ownerId))) return null;
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
 * Own playlists plus friends' non-private playlists, most recently updated
 * first. Friends' rows carry ownerName (own rows do not). Track counts are the
 * playlist's full size; a friend viewing it sees only the subset of tracks they
 * can access (getPlaylistTracks), so the count may exceed what they see inside.
 */
export async function listAccessiblePlaylists(
  userId: string
): Promise<PlaylistDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({
      playlist: playlists,
      ownerName: users.name,
      trackCount: sql<number>`(select count(*)::int from ${playlistTracks}
        where ${playlistTracks.playlistId} = ${playlists.id})`,
    })
    .from(playlists)
    .innerJoin(users, eq(playlists.ownerId, users.id))
    .where(
      or(
        eq(playlists.ownerId, userId),
        friendIds.length
          ? and(
              inArray(playlists.ownerId, friendIds),
              eq(playlists.isPrivate, false)
            )
          : sql`false`
      )
    )
    .orderBy(desc(playlists.updatedAt));
  return Promise.all(
    rows.map((r) =>
      toPlaylistDTO(
        r.playlist,
        r.trackCount,
        r.playlist.ownerId === userId ? null : r.ownerName
      )
    )
  );
}

/**
 * A playlist's tracks in order, filtered by the canAccessTrack rule: a
 * member track that has since been made private or whose owner is no longer
 * a friend is hidden entirely (it couldn't be streamed anyway).
 */
export async function getPlaylistTracks(
  playlistId: string,
  userId: string
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        eq(playlistTracks.playlistId, playlistId),
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false)
              )
            : sql`false`
        )
      )
    )
    .orderBy(asc(playlistTracks.position));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}
