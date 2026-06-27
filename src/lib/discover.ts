import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { listens, trackEmbeddings, tracks, users } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import {
  canonicalFriendCopy,
  notDuplicateOfOwn,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import type { TrackDTO } from "@/lib/types";

// Library access predicate, mirroring listAccessibleTracks: own tracks OR
// friends' non-private tracks, with the same duplicate-hiding applied to
// friend-owned rows when the viewer has it on. Shared by the discovery sections
// (Random pool, Friends-played, New tracks). "Your top 100" deliberately does
// NOT use this — it's your literal play history of specific ids, so it applies
// the access half only (no dedup), inline.
function accessWhere(
  userId: string,
  friendIds: string[],
  hideFriendDuplicates: boolean
) {
  return or(
    eq(tracks.ownerId, userId),
    friendIds.length
      ? and(
          inArray(tracks.ownerId, friendIds),
          eq(tracks.isPrivate, false),
          hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
          hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
        )
      : sql`false`
  );
}

/**
 * "Your top 100": the tracks the viewer played most in the last 7 days, most-
 * played first (≤100). Access-filtered but NOT duplicate-hidden — these are
 * specific tracks you actually played, so collapsing friend-copies would drop
 * rows from your own history. The access filter lives inside the grouped
 * subquery so the 100-cap counts only still-accessible listens (a track you've
 * since lost access to is dropped before the limit, not after).
 */
export async function listTopTracks(userId: string): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);

  const top = db
    .select({
      trackId: listens.trackId,
      plays: sql<number>`count(*)`.as("plays"),
    })
    .from(listens)
    .innerJoin(tracks, eq(tracks.id, listens.trackId))
    .where(
      and(
        eq(listens.userId, userId),
        sql`${listens.playedAt} > now() - interval '7 days'`,
        // Access only (no dedup) — see the doc comment above.
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
    .groupBy(listens.trackId)
    .orderBy(desc(sql`plays`))
    .limit(100)
    .as("top");

  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(top)
    .innerJoin(tracks, eq(tracks.id, top.trackId))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .orderBy(desc(top.plays));

  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * "Random": one completely random accessible track to seed the play-similar
 * radio. Prefers a track that actually has an embedding (so the radio can
 * engage); falls back to any accessible track when none are analyzed yet.
 * Returns null when the accessible library is empty.
 */
export async function randomSeedTrack(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO | null> {
  const friendIds = await friendIdsOf(userId);
  const where = accessWhere(userId, friendIds, hideFriendDuplicates);

  const [withEmbedding] = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .innerJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(where)
    .orderBy(sql`random()`)
    .limit(1);

  let row = withEmbedding;
  if (!row) {
    [row] = await db
      .select({ track: trackDtoColumns, ownerName: users.name })
      .from(tracks)
      .innerJoin(users, eq(tracks.ownerId, users.id))
      .where(where)
      .orderBy(sql`random()`)
      .limit(1);
  }
  if (!row) return null;
  return toTrackDTO(
    row.track,
    row.track.ownerId === userId ? null : row.ownerName
  );
}

/**
 * "Friends": tracks the viewer's friends have played in the last 30 days, most-
 * recently-played first (≤50, one row per track). Access-filtered + duplicate-
 * hidden like the library. Empty when the viewer has no friends. (A wider 30-day
 * window than "Your top 100" so it isn't empty when friends play sporadically.)
 */
export async function listFriendsRecentlyPlayed(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  if (friendIds.length === 0) return [];

  const recent = db
    .select({
      trackId: listens.trackId,
      lastAt: sql<Date>`max(${listens.playedAt})`.as("last_at"),
    })
    .from(listens)
    .innerJoin(tracks, eq(tracks.id, listens.trackId))
    .where(
      and(
        inArray(listens.userId, friendIds),
        sql`${listens.playedAt} > now() - interval '30 days'`,
        accessWhere(userId, friendIds, hideFriendDuplicates)
      )
    )
    .groupBy(listens.trackId)
    .orderBy(desc(sql`last_at`))
    .limit(50)
    .as("recent");

  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(recent)
    .innerJoin(tracks, eq(tracks.id, recent.trackId))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .orderBy(desc(recent.lastAt));

  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * "New tracks": accessible uploads from the last 7 days, newest first (≤100).
 * When nobody (you or your friends) has uploaded recently, falls back to the
 * newest 100 accessible tracks so the section is never empty in a quiet library.
 */
export async function listNewTracks(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const where = accessWhere(userId, friendIds, hideFriendDuplicates);

  const base = () =>
    db
      .select({ track: trackDtoColumns, ownerName: users.name })
      .from(tracks)
      .innerJoin(users, eq(tracks.ownerId, users.id));

  let rows = await base()
    .where(and(sql`${tracks.createdAt} > now() - interval '7 days'`, where))
    .orderBy(desc(tracks.createdAt))
    .limit(100);

  if (rows.length === 0) {
    rows = await base().where(where).orderBy(desc(tracks.createdAt)).limit(100);
  }

  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}
