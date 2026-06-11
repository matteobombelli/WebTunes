import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { friendships, users } from "@/db/schema";
import type { FriendDTO, FriendRequestDTO } from "@/lib/types";

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

/** All accepted friends of a user, with their display fields. */
export async function friendsOf(userId: string): Promise<FriendDTO[]> {
  const ids = await friendIdsOf(userId);
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
}

/** Pending friend requests involving a user, tagged with their direction. */
export async function pendingRequestsFor(
  userId: string
): Promise<FriendRequestDTO[]> {
  const requester = alias(users, "requester");
  const addressee = alias(users, "addressee");
  const rows = await db
    .select({
      id: friendships.id,
      requesterId: friendships.requesterId,
      createdAt: friendships.createdAt,
      requester: {
        id: requester.id,
        name: requester.name,
        email: requester.email,
      },
      addressee: {
        id: addressee.id,
        name: addressee.name,
        email: addressee.email,
      },
    })
    .from(friendships)
    .innerJoin(requester, eq(friendships.requesterId, requester.id))
    .innerJoin(addressee, eq(friendships.addresseeId, addressee.id))
    .where(
      and(
        eq(friendships.status, "pending"),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    );
  return rows.map((r) => ({
    id: r.id,
    direction: r.requesterId === userId ? "outgoing" : "incoming",
    user: r.requesterId === userId ? r.addressee : r.requester,
    createdAt: r.createdAt.toISOString(),
  }));
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
