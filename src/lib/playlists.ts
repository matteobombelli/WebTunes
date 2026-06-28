import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  playlists,
  playlistTracks,
  tracks,
  users,
  type Playlist,
} from "@/db/schema";
import { areFriends, friendIdsOf } from "@/lib/friends";
import { toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

/** ownerName should be null for the viewer's own playlists. */
export async function toPlaylistDTO(
  playlist: Playlist,
  trackCount?: number,
  ownerName: string | null = null
): Promise<PlaylistDTO> {
  // The cover is served through the stable /api/playlists/:id/cover redirect
  // (clients build it from coverS3Key via playlistCoverSrc); we no longer embed
  // a presigned URL here that would expire mid-session.
  return {
    id: playlist.id,
    ownerId: playlist.ownerId,
    name: playlist.name,
    coverS3Key: playlist.coverS3Key,
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

// Track counts for all playlists in one pre-aggregated pass, LEFT JOINed below
// (COALESCE→0 for empty playlists) instead of a per-row correlated subquery.
function playlistTrackCounts() {
  return db
    .select({
      playlistId: playlistTracks.playlistId,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(playlistTracks)
    .groupBy(playlistTracks.playlistId)
    .as("track_counts");
}

/**
 * Up to 4 art-bearing track ids per playlist (in position order), keyed by
 * playlist id, for the no-cover 2x2 mosaic fallback. Filtered by the same access
 * rule as getPlaylistTracks so a mosaic cell never references a track the viewer
 * can't render (no inaccessible UUIDs shipped, no 403/retry holes). Backed by
 * playlist_tracks_position_idx; one extra round-trip keyed on the page's ids.
 */
async function playlistPreviewArt(
  playlistIds: string[],
  userId: string,
  friendIds: string[]
): Promise<Map<string, string[]>> {
  if (playlistIds.length === 0) return new Map();
  const ranked = db
    .select({
      playlistId: playlistTracks.playlistId,
      trackId: playlistTracks.trackId,
      rn: sql<number>`row_number() over (partition by ${playlistTracks.playlistId} order by ${playlistTracks.position})`.as(
        "rn"
      ),
    })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .where(
      and(
        inArray(playlistTracks.playlistId, playlistIds),
        isNotNull(tracks.artS3Key),
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
    .as("ranked");
  const rows = await db
    .select({ playlistId: ranked.playlistId, trackId: ranked.trackId })
    .from(ranked)
    .where(lte(ranked.rn, 4))
    .orderBy(asc(ranked.playlistId), asc(ranked.rn));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.playlistId);
    if (list) list.push(r.trackId);
    else map.set(r.playlistId, [r.trackId]);
  }
  return map;
}

/** Merges mosaic preview art onto the no-cover playlists in a DTO list. */
async function withCoverPreviews(
  dtos: PlaylistDTO[],
  noCoverIds: string[],
  userId: string,
  friendIds: string[]
): Promise<PlaylistDTO[]> {
  if (noCoverIds.length === 0) return dtos;
  const coverMap = await playlistPreviewArt(noCoverIds, userId, friendIds);
  return dtos.map((d) =>
    coverMap.has(d.id) ? { ...d, coverTrackIds: coverMap.get(d.id) } : d
  );
}

/** A user's playlists with track counts, most recently updated first. */
export async function listPlaylistsWithCount(
  userId: string
): Promise<PlaylistDTO[]> {
  const counts = playlistTrackCounts();
  const rows = await db
    .select({
      playlist: playlists,
      trackCount: sql<number>`coalesce(${counts.count}, 0)`,
    })
    .from(playlists)
    .leftJoin(counts, eq(counts.playlistId, playlists.id))
    .where(eq(playlists.ownerId, userId))
    .orderBy(desc(playlists.updatedAt));
  const dtos = await Promise.all(
    rows.map((r) => toPlaylistDTO(r.playlist, r.trackCount))
  );
  const noCoverIds = rows
    .filter((r) => r.playlist.coverS3Key === null)
    .map((r) => r.playlist.id);
  const friendIds = noCoverIds.length ? await friendIdsOf(userId) : [];
  return withCoverPreviews(dtos, noCoverIds, userId, friendIds);
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
  const counts = playlistTrackCounts();
  const rows = await db
    .select({
      playlist: playlists,
      ownerName: users.name,
      trackCount: sql<number>`coalesce(${counts.count}, 0)`,
    })
    .from(playlists)
    .innerJoin(users, eq(playlists.ownerId, users.id))
    .leftJoin(counts, eq(counts.playlistId, playlists.id))
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
  const dtos = await Promise.all(
    rows.map((r) =>
      toPlaylistDTO(
        r.playlist,
        r.trackCount,
        r.playlist.ownerId === userId ? null : r.ownerName
      )
    )
  );
  const noCoverIds = rows
    .filter((r) => r.playlist.coverS3Key === null)
    .map((r) => r.playlist.id);
  return withCoverPreviews(dtos, noCoverIds, userId, friendIds);
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
