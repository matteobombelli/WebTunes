import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { similarExclusions, tracks, users } from "@/db/schema";
import { toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type { TrackDTO } from "@/lib/types";

/** Add a track to the user's "exclude from Play Similar" list (idempotent). */
export async function addExclusion(userId: string, trackId: string) {
  await db
    .insert(similarExclusions)
    .values({ userId, trackId })
    .onConflictDoNothing();
}

/** Remove a track from the user's "exclude from Play Similar" list. */
export async function removeExclusion(userId: string, trackId: string) {
  await db
    .delete(similarExclusions)
    .where(
      and(
        eq(similarExclusions.userId, userId),
        eq(similarExclusions.trackId, trackId)
      )
    );
}

/**
 * The tracks the user has excluded from their Play Similar feed, newest
 * exclusion first. Deliberately NOT access-filtered: a friend's track that has
 * since gone private (or whose owner was unfriended) still appears so the user
 * can remove the entry — it only ever affected this user's own feed anyway.
 * Own tracks map to ownerName null, like listAccessibleTracks.
 */
export async function listExcludedTracks(userId: string): Promise<TrackDTO[]> {
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(similarExclusions)
    .innerJoin(tracks, eq(similarExclusions.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(eq(similarExclusions.userId, userId))
    .orderBy(desc(similarExclusions.createdAt));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}
