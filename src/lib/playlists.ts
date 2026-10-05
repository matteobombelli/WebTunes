import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, isUniqueViolation, type DbExecutor } from "@/db";
import {
  friendships,
  playlistCollaborators,
  playlists,
  playlistTracks,
  tracks,
  users,
  type Playlist,
} from "@/db/schema";
import {
  areFriends,
  canAccessTrackWithFriends,
  friendIdsOf,
} from "@/lib/friends";
import { imageKindFromBytes } from "@/lib/image-upload";
import { log } from "@/lib/log";
import { deleteObject, getObjectBytes, uploadObject } from "@/lib/s3";
import { isLibraryTrack, toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type { FriendDTO, PlaylistDTO, TrackDTO } from "@/lib/types";
import { getDisplayName } from "@/lib/users";
import { isUuid } from "@/lib/validate";

type PlaylistRole = "owner" | "collaborator" | null;

function acceptedCollaboratorFriendship() {
  return and(
    eq(friendships.status, "accepted"),
    or(
      and(
        eq(friendships.requesterId, playlists.ownerId),
        eq(friendships.addresseeId, playlistCollaborators.userId)
      ),
      and(
        eq(friendships.requesterId, playlistCollaborators.userId),
        eq(friendships.addresseeId, playlists.ownerId)
      )
    )
  );
}

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

/** True if the user is a current-friend collaborator (not the owner). */
async function isCollaborator(
  playlistId: string,
  userId: string,
  exec: DbExecutor = db
): Promise<boolean> {
  const [row] = await exec
    .select({ userId: playlistCollaborators.userId })
    .from(playlistCollaborators)
    .innerJoin(
      playlists,
      eq(playlistCollaborators.playlistId, playlists.id)
    )
    .innerJoin(friendships, acceptedCollaboratorFriendship())
    .where(
      and(
        eq(playlistCollaborators.playlistId, playlistId),
        eq(playlistCollaborators.userId, userId)
      )
    )
    .limit(1);
  return !!row;
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

/**
 * getEditablePlaylist, but row-locked for the rest of `tx`. Every membership
 * mutation below locks the playlist first, which serializes concurrent edits of
 * one playlist so before-states and positions read inside the transaction stay
 * true until it commits.
 */
export async function lockEditablePlaylist(
  tx: DbExecutor,
  playlistId: string,
  userId: string
): Promise<Playlist | null> {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await tx
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .for("update");
  if (!playlist) return null;
  if (playlist.ownerId === userId) return playlist;
  return (await isCollaborator(playlistId, userId, tx)) ? playlist : null;
}

function touchPlaylist(tx: DbExecutor, playlistId: string) {
  return tx
    .update(playlists)
    .set({ updatedAt: new Date() })
    .where(eq(playlists.id, playlistId));
}

export async function createPlaylist(
  userId: string,
  name: string,
  exec: DbExecutor = db
): Promise<Playlist> {
  const [playlist] = await exec
    .insert(playlists)
    .values({ ownerId: userId, name })
    .returning();
  return playlist;
}

export type UpdatePlaylistResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | {
      status: "ok";
      before: { name: string; isPrivate: boolean };
      playlist: Playlist;
    };

/** Editors (owner or collaborator) may rename; changing privacy is owner-only. */
export function updatePlaylist(
  playlistId: string,
  userId: string,
  fields: { name?: string; isPrivate?: boolean },
  exec: DbExecutor = db
): Promise<UpdatePlaylistResult> {
  return exec.transaction(async (tx) => {
    const playlist = await lockEditablePlaylist(tx, playlistId, userId);
    if (!playlist) return { status: "not_found" };
    const { name, isPrivate } = fields;
    if (isPrivate !== undefined && playlist.ownerId !== userId) {
      return { status: "forbidden" };
    }
    const [updated] = await tx
      .update(playlists)
      .set({
        ...(name !== undefined && { name }),
        ...(isPrivate !== undefined && { isPrivate }),
        updatedAt: new Date(),
      })
      .where(eq(playlists.id, playlistId))
      .returning();
    return {
      status: "ok",
      before: { name: playlist.name, isPrivate: playlist.isPrivate },
      playlist: updated,
    };
  });
}

export type AddPlaylistTracksResult =
  | { status: "not_found" }
  | { status: "track_not_found" }
  | { status: "forbidden" }
  | { status: "already_present" }
  | { status: "ok"; added: string[] };

/**
 * Append accessible tracks in request order, skipping ones already present.
 * The whole request fails if any id is missing or inaccessible, and reports
 * already_present when nothing is left to add.
 */
export async function addPlaylistTracks(
  playlistId: string,
  userId: string,
  trackIds: string[],
  exec: DbExecutor = db
): Promise<AddPlaylistTracksResult> {
  try {
    return await exec.transaction(async (tx) => {
      if (!(await lockEditablePlaylist(tx, playlistId, userId))) {
        return { status: "not_found" };
      }
      if (!trackIds.every(isUuid)) return { status: "track_not_found" };
      const candidates = await tx
        .select({
          id: tracks.id,
          ownerId: tracks.ownerId,
          isPrivate: tracks.isPrivate,
          suggestedImportId: tracks.suggestedImportId,
        })
        .from(tracks)
        .where(inArray(tracks.id, trackIds));
      if (candidates.length !== trackIds.length) {
        return { status: "track_not_found" };
      }
      const friendIds = await friendIdsOf(userId);
      for (const track of candidates) {
        if (!canAccessTrackWithFriends(userId, track, friendIds)) {
          return { status: "forbidden" };
        }
      }

      const existing = await tx
        .select({ trackId: playlistTracks.trackId })
        .from(playlistTracks)
        .where(
          and(
            eq(playlistTracks.playlistId, playlistId),
            inArray(playlistTracks.trackId, trackIds)
          )
        );
      const existingIds = new Set(existing.map((e) => e.trackId));
      const toAdd = trackIds.filter((tid) => !existingIds.has(tid));
      if (toAdd.length === 0) return { status: "already_present" };

      const [{ base }] = await tx
        .select({
          base: sql<number>`coalesce(max(${playlistTracks.position}) + 1, 0)::int`,
        })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId));
      await tx.insert(playlistTracks).values(
        toAdd.map((trackId, i) => ({
          playlistId,
          trackId,
          position: base + i,
        }))
      );
      await touchPlaylist(tx, playlistId);
      return { status: "ok", added: toAdd };
    });
  } catch (err) {
    // The (playlist_id, track_id) PK is the backstop should a concurrent insert
    // ever bypass the playlist lock.
    if (isUniqueViolation(err)) return { status: "already_present" };
    throw err;
  }
}

/** Member track ids in playlist order. */
export async function getPlaylistTrackIds(
  playlistId: string,
  exec: DbExecutor = db
): Promise<string[]> {
  const rows = await exec
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position));
  return rows.map((r) => r.trackId);
}

export type ReorderPlaylistTracksResult =
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "ok"; before: string[] };

/**
 * `trackIds` must be a permutation of the playlist's CURRENT members - a
 * partial / padded / duplicated list is rejected so positions can't end up
 * colliding or non-contiguous (the web client always sends the full list).
 */
export function reorderPlaylistTracks(
  playlistId: string,
  userId: string,
  trackIds: string[],
  exec: DbExecutor = db
): Promise<ReorderPlaylistTracksResult> {
  return exec.transaction(async (tx) => {
    if (!(await lockEditablePlaylist(tx, playlistId, userId))) {
      return { status: "not_found" };
    }
    const members = await tx
      .select({ trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(asc(playlistTracks.position));
    const submittedSet = new Set(trackIds);
    const memberSet = new Set(members.map((m) => m.trackId));
    const isPermutation =
      trackIds.length === submittedSet.size && // no duplicates
      submittedSet.size === memberSet.size &&
      [...submittedSet].every((tid) => memberSet.has(tid));
    if (!isPermutation) return { status: "invalid" };

    // One set-based statement instead of one UPDATE per track: a drag-drop in a
    // large playlist would otherwise hold the transaction (and row locks) across
    // hundreds of sequential round-trips. sql.param keeps the id array a single
    // $1::uuid[] parameter - plain ${array} interpolation expands to ($1, $2, …),
    // which Postgres can't cast to uuid[].
    await tx.execute(sql`
      update ${playlistTracks} set "position" = v.ord - 1
      from unnest(${sql.param(trackIds)}::uuid[]) with ordinality as v(track_id, ord)
      where ${playlistTracks.playlistId} = ${playlistId}
        and ${playlistTracks.trackId} = v.track_id
    `);
    await touchPlaylist(tx, playlistId);
    return { status: "ok", before: members.map((m) => m.trackId) };
  });
}

export type RemovePlaylistTracksResult =
  | { status: "not_found" }
  | { status: "ok"; removed: { trackId: string; position: number }[] };

/**
 * Remove tracks, closing the gaps so positions stay contiguous. Non-members
 * (and non-UUID ids) are ignored; `removed` carries each removed track's
 * position before this call, ascending.
 */
export function removePlaylistTracks(
  playlistId: string,
  userId: string,
  trackIds: string[],
  exec: DbExecutor = db
): Promise<RemovePlaylistTracksResult> {
  return exec.transaction(async (tx) => {
    if (!(await lockEditablePlaylist(tx, playlistId, userId))) {
      return { status: "not_found" };
    }
    const ids = trackIds.filter(isUuid);
    if (ids.length === 0) return { status: "ok", removed: [] };
    const removed = await tx
      .delete(playlistTracks)
      .where(
        and(
          eq(playlistTracks.playlistId, playlistId),
          inArray(playlistTracks.trackId, ids)
        )
      )
      .returning({
        trackId: playlistTracks.trackId,
        position: playlistTracks.position,
      });
    if (removed.length === 0) return { status: "ok", removed: [] };
    removed.sort((a, b) => a.position - b.position);
    const positions = removed.map((r) => r.position);
    // Each survivor moves up by the number of removed positions before it.
    await tx
      .update(playlistTracks)
      .set({
        position: sql`${playlistTracks.position} - (
          select count(*)::int from unnest(${sql.param(positions)}::int[]) as r(p)
          where r.p < ${playlistTracks.position}
        )`,
      })
      .where(
        and(
          eq(playlistTracks.playlistId, playlistId),
          gt(playlistTracks.position, positions[0])
        )
      );
    // Removing a track changes the playlist's contents, so bump updatedAt
    // (list ordering + DTO), like add/reorder/rename/cover do. A no-op removal
    // (non-member) returned above without bumping.
    await touchPlaylist(tx, playlistId);
    return { status: "ok", removed };
  });
}

export type InsertPlaylistTracksAtResult =
  | { status: "not_found" }
  | {
      status: "ok";
      inserted: string[];
      skipped: {
        trackId: string;
        reason: "already_present" | "missing" | "inaccessible";
      }[];
    };

/**
 * Re-insert tracks at given positions (the inverse of removePlaylistTracks).
 * Items are applied in ascending position order, each at min(position, current
 * length), shifting later rows down. Present, missing, and inaccessible tracks
 * are skipped rather than failing the call.
 */
export function insertPlaylistTracksAt(
  playlistId: string,
  userId: string,
  items: { trackId: string; position: number }[],
  exec: DbExecutor = db
): Promise<InsertPlaylistTracksAtResult> {
  return exec.transaction(async (tx) => {
    if (!(await lockEditablePlaylist(tx, playlistId, userId))) {
      return { status: "not_found" };
    }
    const skipped: Extract<
      InsertPlaylistTracksAtResult,
      { status: "ok" }
    >["skipped"] = [];
    const ids = items.map((i) => i.trackId).filter(isUuid);
    const members = await tx
      .select({ trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId));
    const candidates = ids.length
      ? await tx
          .select({
            id: tracks.id,
            ownerId: tracks.ownerId,
            isPrivate: tracks.isPrivate,
            suggestedImportId: tracks.suggestedImportId,
          })
          .from(tracks)
          .where(inArray(tracks.id, ids))
      : [];
    const friendIds = await friendIdsOf(userId);
    const present = new Set(members.map((m) => m.trackId));
    const byId = new Map(candidates.map((c) => [c.id, c]));
    let length = members.length;
    const inserted: string[] = [];
    const ordered = [...items].sort((a, b) => a.position - b.position);
    for (const { trackId, position } of ordered) {
      const track = byId.get(trackId);
      if (present.has(trackId)) {
        skipped.push({ trackId, reason: "already_present" });
      } else if (!track) {
        skipped.push({ trackId, reason: "missing" });
      } else if (!canAccessTrackWithFriends(userId, track, friendIds)) {
        skipped.push({ trackId, reason: "inaccessible" });
      } else {
        const at = Math.min(Math.max(position, 0), length);
        await tx
          .update(playlistTracks)
          .set({ position: sql`${playlistTracks.position} + 1` })
          .where(
            and(
              eq(playlistTracks.playlistId, playlistId),
              gte(playlistTracks.position, at)
            )
          );
        await tx
          .insert(playlistTracks)
          .values({ playlistId, trackId, position: at });
        present.add(trackId);
        inserted.push(trackId);
        length++;
      }
    }
    if (inserted.length) await touchPlaylist(tx, playlistId);
    return { status: "ok", inserted, skipped };
  });
}

export type DeleteOwnedPlaylistResult =
  | { status: "not_found" }
  | { status: "ok"; objectKeys: string[] };

/**
 * Owner-only. The cover object is returned, not deleted: the caller removes it
 * after its transaction commits (row first, object second).
 */
export function deleteOwnedPlaylist(
  playlistId: string,
  userId: string,
  exec: DbExecutor = db
): Promise<DeleteOwnedPlaylistResult> {
  return exec.transaction(async (tx) => {
    if (!isUuid(playlistId)) return { status: "not_found" };
    const [deleted] = await tx
      .delete(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.ownerId, userId)))
      .returning({ coverS3Key: playlists.coverS3Key });
    if (!deleted) return { status: "not_found" };
    return {
      status: "ok",
      objectKeys: deleted.coverS3Key ? [deleted.coverS3Key] : [],
    };
  });
}

/** Collaborators (id + name) on a playlist, alphabetical. */
export async function listCollaborators(
  playlistId: string
): Promise<FriendDTO[]> {
  const rows = await db
    .selectDistinct({ id: users.id, name: users.name })
    .from(playlistCollaborators)
    .innerJoin(
      playlists,
      eq(playlistCollaborators.playlistId, playlists.id)
    )
    .innerJoin(users, eq(playlistCollaborators.userId, users.id))
    .innerJoin(friendships, acceptedCollaboratorFriendship())
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
  return (await loadAccessiblePlaylist(playlistId, userId))?.playlist ?? null;
}

/** getAccessiblePlaylist plus the viewer's role, which the checks already find. */
async function loadAccessiblePlaylist(playlistId: string, userId: string) {
  if (!isUuid(playlistId)) return null;
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist) return null;
  if (playlist.ownerId === userId) return { playlist, role: "owner" as const };
  // A collaborator can view (and edit) the playlist even when it's private.
  if (await isCollaborator(playlistId, userId)) {
    return { playlist, role: "collaborator" as const };
  }
  if (playlist.isPrivate) return null;
  if (!(await areFriends(userId, playlist.ownerId))) return null;
  return { playlist, role: null };
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
    .selectDistinct({ id: playlistCollaborators.playlistId })
    .from(playlistCollaborators)
    .innerJoin(
      playlists,
      eq(playlistCollaborators.playlistId, playlists.id)
    )
    .innerJoin(friendships, acceptedCollaboratorFriendship())
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
  const counts = playlistTrackCounts();
  const [friendIds, collabRows] = await Promise.all([
    friendIdsOf(userId),
    db
      .selectDistinct({ id: playlistCollaborators.playlistId })
      .from(playlistCollaborators)
      .innerJoin(
        playlists,
        eq(playlistCollaborators.playlistId, playlists.id)
      )
      .innerJoin(friendships, acceptedCollaboratorFriendship())
      .where(eq(playlistCollaborators.userId, userId)),
  ]);
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

/** A viewer-accessible playlist with its visible tracks; null otherwise. */
export async function getPlaylistWithTracks(
  playlistId: string,
  userId: string
): Promise<(PlaylistDTO & { tracks: TrackDTO[] }) | null> {
  const access = await loadAccessiblePlaylist(playlistId, userId);
  if (!access) return null;
  const { playlist, role } = access;

  const isOwner = playlist.ownerId === userId;
  const [trackDTOs, ownerName] = await Promise.all([
    getPlaylistTracks(playlistId, userId),
    isOwner ? Promise.resolve(null) : getDisplayName(playlist.ownerId),
  ]);
  return {
    ...(await toPlaylistDTO(playlist, trackDTOs.length, ownerName, role)),
    tracks: trackDTOs,
  };
}

const COPY_SUFFIX = " (copy)";

/**
 * Snapshot any playlist the viewer can access into a new playlist they own.
 * Only currently accessible tracks are copied, in their visible order; this
 * keeps friend-track privacy identical to the source view. Collaborators are
 * deliberately not inherited. An explicit cover is copied to an independent
 * S3 object so deleting or changing either playlist cannot break the other.
 */
export async function duplicatePlaylist(
  playlistId: string,
  userId: string
): Promise<PlaylistDTO | null> {
  const source = await getAccessiblePlaylist(playlistId, userId);
  if (!source) return null;

  const sourceTracks = await getPlaylistTracks(playlistId, userId);
  const copyName = `${source.name
    .slice(0, 100 - COPY_SUFFIX.length)
    .trimEnd()}${COPY_SUFFIX}`;

  let copy = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(playlists)
      .values({
        ownerId: userId,
        name: copyName,
        isPrivate: source.isPrivate,
      })
      .returning();

    if (sourceTracks.length) {
      await tx.insert(playlistTracks).values(
        sourceTracks.map((track, position) => ({
          playlistId: created.id,
          trackId: track.id,
          position,
        }))
      );
    }
    return created;
  });

  // DB first, object second: a failed copy leaves a valid playlist using its
  // track-art mosaic, never a row pointing at a missing cover object.
  if (source.coverS3Key) {
    let copiedKey: string | null = null;
    try {
      const bytes = await getObjectBytes(source.coverS3Key);
      const kind = imageKindFromBytes(bytes);
      if (!kind) throw new Error("unsupported cover bytes");

      copiedKey = `covers/${userId}/${copy.id}.${kind.ext}`;
      await uploadObject(copiedKey, bytes, kind.contentType);
      const [withCover] = await db
        .update(playlists)
        .set({ coverS3Key: copiedKey })
        .where(eq(playlists.id, copy.id))
        .returning();
      if (withCover) copy = withCover;
      else await deleteObject(copiedKey).catch(() => {});
    } catch {
      if (copiedKey) await deleteObject(copiedKey).catch(() => {});
      log.warn("playlists", "Could not copy playlist cover", {
        sourcePlaylistId: source.id,
        copyPlaylistId: copy.id,
      });
    }
  }

  return toPlaylistDTO(copy, sourceTracks.length, null, "owner");
}
