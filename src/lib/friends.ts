import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cache } from "react";
import { db } from "@/db";
import { friendships, users } from "@/db/schema";
import type {
  FriendDTO,
  FriendRequestDTO,
  FriendSuggestionDTO,
} from "@/lib/types";

// Wrapped in React's per-request cache(): the (app) layout and the page it
// renders both reach for friendship data on the same request, and so do the
// per-thumbnail /art and /stream access checks. cache() collapses those to one
// query each per request (no effect across requests).
export const areFriends = cache(async function areFriends(
  a: string,
  b: string
): Promise<boolean> {
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
});

/** IDs of all accepted friends of a user (both directions). */
export const friendIdsOf = cache(async function friendIdsOf(
  userId: string
): Promise<string[]> {
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
});

/** All accepted friends of a user (username only — email is never exposed). */
export async function friendsOf(userId: string): Promise<FriendDTO[]> {
  const ids = await friendIdsOf(userId);
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
}

/**
 * "You might know" suggestions: accepted friends of the viewer's accepted
 * friends, whom the viewer isn't already friends with and has no pending
 * request with. Ranked by number of mutual friends (desc), then username.
 */
export async function suggestedFriendsFor(
  userId: string,
  limit = 12
): Promise<FriendSuggestionDTO[]> {
  const friendIds = await friendIdsOf(userId);
  if (friendIds.length === 0) return [];

  // Anyone with a pending request (either direction) is also excluded.
  const pendingRows = await db
    .select({
      requesterId: friendships.requesterId,
      addresseeId: friendships.addresseeId,
    })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "pending"),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    );
  const pendingIds = pendingRows.map((r) =>
    r.requesterId === userId ? r.addresseeId : r.requesterId
  );

  const friendIdList = sql.join(
    friendIds.map((id) => sql`${id}`),
    sql`, `
  );
  // Each accepted edge with one endpoint among the viewer's friends contributes
  // its OTHER endpoint as a candidate; the candidate joins to `users`. Counting
  // those edges per candidate = the candidate's mutual-friend count. Candidates
  // who are themselves the viewer, an existing friend, or a pending-request user
  // are excluded — which also drops edges where BOTH endpoints are friends.
  const candidateId = sql`case when ${friendships.requesterId} in (${friendIdList}) then ${friendships.addresseeId} else ${friendships.requesterId} end`;

  return db
    .select({
      id: users.id,
      name: users.name,
      mutualCount: sql<number>`count(*)::int`,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, candidateId))
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          inArray(friendships.requesterId, friendIds),
          inArray(friendships.addresseeId, friendIds)
        ),
        notInArray(users.id, [userId, ...friendIds, ...pendingIds])
      )
    )
    .groupBy(users.id)
    .orderBy(desc(sql`count(*)`), users.name)
    .limit(limit);
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
      },
      addressee: {
        id: addressee.id,
        name: addressee.name,
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

/**
 * The same access rule as canAccessTrack, but DB-free: for callers that have
 * already loaded the viewer's friend ids (e.g. a query that also needs them),
 * so they don't pay a second areFriends round-trip.
 */
export function canAccessTrackWithFriends(
  userId: string,
  track: { ownerId: string; isPrivate: boolean },
  friendIds: string[]
): boolean {
  if (userId === track.ownerId) return true;
  if (track.isPrivate) return false;
  return friendIds.includes(track.ownerId);
}
