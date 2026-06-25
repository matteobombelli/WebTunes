import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tracks, users, type Track } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import type { TrackDTO } from "@/lib/types";

/**
 * Columns the TrackDTO needs from `tracks`. Deliberately excludes `lyrics` /
 * `lyricsSource` (never read by the client — they only feed `search_vector`) and
 * `contentHash` (a server-side dedupe detail). List queries select this
 * projection so they don't ship KBs of lyrics text per row.
 */
export const trackDtoColumns = {
  id: tracks.id,
  ownerId: tracks.ownerId,
  title: tracks.title,
  artist: tracks.artist,
  album: tracks.album,
  durationSec: tracks.durationSec,
  loudnessLufs: tracks.loudnessLufs,
  s3Key: tracks.s3Key,
  artS3Key: tracks.artS3Key,
  mimeType: tracks.mimeType,
  fileSize: tracks.fileSize,
  isPrivate: tracks.isPrivate,
  friendPlayCount: tracks.friendPlayCount,
  createdAt: tracks.createdAt,
};

type TrackRow = Pick<Track, keyof typeof trackDtoColumns>;

/**
 * ownerName should be null for the viewer's own tracks. Built field-by-field so
 * it can't leak excluded columns (lyrics/contentHash) even when handed a full
 * row from a `select()` (e.g. the upload/detail paths).
 */
export function toTrackDTO(
  track: TrackRow,
  ownerName: string | null = null
): TrackDTO {
  return {
    id: track.id,
    ownerId: track.ownerId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    loudnessLufs: track.loudnessLufs,
    s3Key: track.s3Key,
    artS3Key: track.artS3Key,
    mimeType: track.mimeType,
    fileSize: track.fileSize,
    isPrivate: track.isPrivate,
    friendPlayCount: track.friendPlayCount,
    createdAt: track.createdAt.toISOString(),
    ownerName,
  };
}

/**
 * SQL filter: the (outer) tracks row is not a duplicate of one of the
 * viewer's own tracks. "Duplicate" = same title + artist, case- and
 * whitespace-insensitive. Apply to friend-owned rows only.
 */
export function notDuplicateOfOwn(userId: string) {
  return sql`not exists (
    select 1 from ${tracks} own
    where own.owner_id = ${userId}
      and lower(btrim(own.title)) = lower(btrim(${tracks.title}))
      and lower(btrim(coalesce(own.artist, ''))) = lower(btrim(coalesce(${tracks.artist}, '')))
  )`;
}

/**
 * SQL filter (apply to friend-owned rows): this friend's copy is the canonical
 * one for its song — i.e. no OTHER friend has a copy of the same title + artist
 * (case/whitespace-insensitive) with a smaller id. Collapses the same song
 * owned by two different friends down to a single (lowest-id) row. `friendIds`
 * must be the viewer's friends, so an inaccessible stranger's copy can never
 * suppress a friend's track. Returns undefined when there are no friends —
 * nothing to dedupe. Pair with notDuplicateOfOwn so own copies always win.
 */
export function canonicalFriendCopy(friendIds: string[]) {
  if (!friendIds.length) return undefined;
  const ids = sql.join(
    friendIds.map((id) => sql`${id}`),
    sql`, `
  );
  return sql`not exists (
    select 1 from ${tracks} other
    where other.id < ${tracks.id}
      and other.owner_id in (${ids})
      and other.is_private = false
      and lower(btrim(other.title)) = lower(btrim(${tracks.title}))
      and lower(btrim(coalesce(other.artist, ''))) = lower(btrim(coalesce(${tracks.artist}, '')))
  )`;
}

/** The user's own tracks, newest first. */
export async function listOwnTracks(userId: string): Promise<TrackDTO[]> {
  const rows = await db
    .select(trackDtoColumns)
    .from(tracks)
    .where(eq(tracks.ownerId, userId))
    .orderBy(desc(tracks.createdAt));
  return rows.map((t) => toTrackDTO(t));
}

/**
 * Own tracks plus friends' non-private tracks, newest first. With
 * hideFriendDuplicates, friends' copies of songs the user already has
 * (per notDuplicateOfOwn) are excluded.
 */
export async function listAccessibleTracks(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      or(
        eq(tracks.ownerId, userId),
        friendIds.length
          ? and(
              inArray(tracks.ownerId, friendIds),
              eq(tracks.isPrivate, false),
              hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
              hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
            )
          : sql`false`
      )
    )
    .orderBy(desc(tracks.createdAt));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * Accessible tracks (own + friends' non-private) whose `field` matches `value`
 * case- and whitespace-insensitively, ordered by title. Honors
 * hideFriendDuplicates like listAccessibleTracks. Backs the album/artist pages.
 */
async function listAccessibleTracksByField(
  userId: string,
  field: typeof tracks.album | typeof tracks.artist,
  value: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const matches = sql`lower(btrim(coalesce(${field}, ''))) = lower(btrim(${value}))`;
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        matches,
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
                hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
              )
            : sql`false`
        )
      )
    )
    .orderBy(tracks.title);
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/** Accessible tracks on a given album. */
export function listTracksByAlbum(
  userId: string,
  album: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  return listAccessibleTracksByField(
    userId,
    tracks.album,
    album,
    hideFriendDuplicates
  );
}

/** Accessible tracks by a given artist. */
export function listTracksByArtist(
  userId: string,
  artist: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  return listAccessibleTracksByField(
    userId,
    tracks.artist,
    artist,
    hideFriendDuplicates
  );
}

/** A friend's non-private tracks, newest first. Caller checks the friendship. */
export async function listFriendTracks(
  friendId: string,
  ownerName: string | null
): Promise<TrackDTO[]> {
  const rows = await db
    .select(trackDtoColumns)
    .from(tracks)
    .where(and(eq(tracks.ownerId, friendId), eq(tracks.isPrivate, false)))
    .orderBy(desc(tracks.createdAt));
  return rows.map((t) => toTrackDTO(t, ownerName));
}
