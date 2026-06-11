import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { friendships } from "@/db/schema";

export async function areFriends(a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          and(
            eq(friendships.requesterId, a),
            eq(friendships.addresseeId, b)
          ),
          and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a))
        )
      )
    )
    .limit(1);
  return !!row;
}

/** IDs of all accepted friends of a user (both directions). */
export async function friendIdsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      requesterId: friendships.requesterId,
      addresseeId: friendships.addresseeId,
    })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    );
  return rows.map((r) =>
    r.requesterId === userId ? r.addresseeId : r.requesterId
  );
}

/**
 * A user may access a track they own, or a non-private track owned by an
 * accepted friend.
 */
export async function canAccessTrack(
  userId: string,
  track: { ownerId: string; isPrivate: boolean }
): Promise<boolean> {
  if (userId === track.ownerId) return true;
  if (track.isPrivate) return false;
  return areFriends(userId, track.ownerId);
}
