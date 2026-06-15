import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tracks, users, type Track } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import type { TrackDTO } from "@/lib/types";

/** ownerName should be null for the viewer's own tracks. */
export function toTrackDTO(
  track: Track,
  ownerName: string | null = null
): TrackDTO {
  // contentHash is a server-side dedupe detail; keep it off the wire.
  const { contentHash, ...rest } = track;
  void contentHash;
  return { ...rest, createdAt: track.createdAt.toISOString(), ownerName };
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

/** The user's own tracks, newest first. */
export async function listOwnTracks(userId: string): Promise<TrackDTO[]> {
  const rows = await db
    .select()
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
    .select({ track: tracks, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      or(
        eq(tracks.ownerId, userId),
        friendIds.length
          ? and(
              inArray(tracks.ownerId, friendIds),
              eq(tracks.isPrivate, false),
              hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined
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
    .select({ track: tracks, ownerName: users.name })
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
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined
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
    .select()
    .from(tracks)
    .where(and(eq(tracks.ownerId, friendId), eq(tracks.isPrivate, false)))
    .orderBy(desc(tracks.createdAt));
  return rows.map((t) => toTrackDTO(t, ownerName));
}
