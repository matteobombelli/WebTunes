import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  playlistCollaborators,
  playlists,
  playlistTracks,
  tracks,
  users,
  type Playlist,
} from "@/db/schema";
import { areFriends, friendIdsOf } from "@/lib/friends";
import { isLibraryTrack, toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type { FriendDTO, PlaylistDTO, TrackDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

export type PlaylistRole = "owner" | "collaborator" | null;

/**
 * ownerName should be null for the viewer's own playlists. `role` marks the
 * viewer's edit relationship (owner / collaborator / read-only friend view).
 */
export async function toPlaylistDTO(
  playlist: Playlist,
  trackCount?: number,
  ownerName: string | null = null,
  role: PlaylistRole = null
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
    role,
  };
}

/** True if the user is a collaborator (not the owner) on this playlist. */
async function isCollaborator(
  playlistId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ userId: playlistCollaborators.userId })
    .from(playlistCollaborators)
    .where(
      and(
        eq(playlistCollaborators.playlistId, playlistId),
        eq(playlistCollaborators.userId, userId)
      )
    );
  return !!row;
}

/** The viewer's edit relationship to a playlist: owner, collaborator, or null. */
export async function getPlaylistRole(
  playlistId: string,
  userId: string
): Promise<PlaylistRole> {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select({ ownerId: playlists.ownerId })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist) return null;
  if (playlist.ownerId === userId) return "owner";
  return (await isCollaborator(playlistId, userId)) ? "collaborator" : null;
}

/**
 * Loads a playlist the user may EDIT (add/remove/reorder tracks, rename, change
 * cover): their own, or one a friend added them to as a collaborator. Returns
 * null otherwise. Owner-only actions (privacy, delete, managing collaborators)
 * must still use getOwnPlaylist.
 */
export async function getEditablePlaylist(playlistId: string, userId: string) {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist) return null;
  if (playlist.ownerId === userId) return playlist;
  return (await isCollaborator(playlistId, userId)) ? playlist : null;
}

/** Collaborators (id + name) on a playlist, alphabetical. */
export async function listCollaborators(
  playlistId: string
): Promise<FriendDTO[]> {
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(playlistCollaborators)
    .innerJoin(users, eq(playlistCollaborators.userId, users.id))
    .where(eq(playlistCollaborators.playlistId, playlistId))
    .orderBy(asc(users.name));
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Grant a friend edit access. Caller enforces ownership + friendship. */
export async function addCollaborator(playlistId: string, userId: string) {
  await db.insert(playlistCollaborators).values({ playlistId, userId });
}

/** Revoke a collaborator (owner removes anyone; a collaborator removes self). */
export async function removeCollaborator(playlistId: string, userId: string) {
  await db
    .delete(playlistCollaborators)
    .where(
      and(
        eq(playlistCollaborators.playlistId, playlistId),
        eq(playlistCollaborators.userId, userId)
      )
    );
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
 * Loads a playlist the user may view: their own, one they collaborate on (even
 * if private), or a non-private playlist owned by an accepted friend. Returns
 * null otherwise. Mutations must still use getOwnPlaylist/getEditablePlaylist -
 * this is read access only.
 */
export async function getAccessiblePlaylist(playlistId: string, userId: string) {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist) return null;
  if (playlist.ownerId === userId) return playlist;
  // A collaborator can view (and edit) the playlist even when it's private.
  if (await isCollaborator(playlistId, userId)) return playlist;
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
        isLibraryTrack(),
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

/**
 * A user's editable playlists - their own plus playlists a friend added them to
 * as a collaborator - with track counts, most recently updated first. Own rows
 * carry role "owner" (no ownerName); collaborated rows carry role "collaborator"
 * and the owner's name.
 */
export async function listPlaylistsWithCount(
  userId: string
): Promise<PlaylistDTO[]> {
  const counts = playlistTrackCounts();
  const collabIds = db
    .select({ id: playlistCollaborators.playlistId })
    .from(playlistCollaborators)
    .where(eq(playlistCollaborators.userId, userId));
  const rows = await db
    .select({
      playlist: playlists,
      ownerName: users.name,
      trackCount: sql<number>`coalesce(${counts.count}, 0)`,
    })
    .from(playlists)
    .innerJoin(users, eq(playlists.ownerId, users.id))
    .leftJoin(counts, eq(counts.playlistId, playlists.id))
    .where(or(eq(playlists.ownerId, userId), inArray(playlists.id, collabIds)))
    .orderBy(desc(playlists.updatedAt));
  const dtos = await Promise.all(
    rows.map((r) => {
      const isOwner = r.playlist.ownerId === userId;
      return toPlaylistDTO(
        r.playlist,
        r.trackCount,
        isOwner ? null : r.ownerName,
        isOwner ? "owner" : "collaborator"
      );
    })
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
  const collabRows = await db
    .select({ id: playlistCollaborators.playlistId })
    .from(playlistCollaborators)
    .where(eq(playlistCollaborators.userId, userId));
  const collabSet = new Set(collabRows.map((r) => r.id));
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
        collabSet.size ? inArray(playlists.id, [...collabSet]) : sql`false`,
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
    rows.map((r) => {
      const isOwner = r.playlist.ownerId === userId;
      const role: PlaylistRole = isOwner
        ? "owner"
        : collabSet.has(r.playlist.id)
          ? "collaborator"
          : null;
      return toPlaylistDTO(
        r.playlist,
        r.trackCount,
        isOwner ? null : r.ownerName,
        role
      );
    })
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
        isLibraryTrack(),
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
