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
  return { ...track, createdAt: track.createdAt.toISOString(), ownerName };
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

/** Own tracks plus friends' non-private tracks, newest first. */
export async function listAccessibleTracks(
  userId: string
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
          ? and(inArray(tracks.ownerId, friendIds), eq(tracks.isPrivate, false))
          : sql`false`
      )
    )
    .orderBy(desc(tracks.createdAt));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
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
