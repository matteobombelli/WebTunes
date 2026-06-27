import { and, desc, eq, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  listens,
  similarExclusions,
  trackEmbeddings,
  tracks,
  users,
} from "@/db/schema";
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
// friend-owned rows when the viewer has it on. Shared by every discovery section.
// The play-history sections ("Your top 100", a friend's top, friends' combined
// top) pass it through topTracksByRecency; pass hideFriendDuplicates=false there
// to get the access half only (no dedup) — e.g. "Your top 100" must not collapse
// friend-copies out of your own play history.
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
 * Shared "Top 100" ranking for the play-history sections. Ranks the distinct
 * tracks played by any of `listenerIds` by their play count in the last 7 days;
 * if fewer than `limit` tracks have recent plays, backfills with the most-played
 * *older* tracks (those with no plays in the window) until `limit` is reached, or
 * the accessible library runs out. `accessClause` is the viewer's access predicate
 * (from accessWhere), applied inside the grouped query so the cap counts only
 * still-accessible listens. Owner name is suppressed for the viewer's own tracks.
 */
async function topTracksByRecency({
  listenerIds,
  accessClause,
  viewerId,
  limit = 100,
}: {
  listenerIds: string[];
  accessClause: ReturnType<typeof accessWhere>;
  viewerId: string;
  limit?: number;
}): Promise<TrackDTO[]> {
  if (listenerIds.length === 0) return [];

  const listener = inArray(listens.userId, listenerIds);
  const rank = (where: SQL | undefined, take: number) =>
    db
      .select({
        trackId: listens.trackId,
        plays: sql<number>`count(*)`.as("plays"),
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(where)
      .groupBy(listens.trackId)
      .orderBy(desc(sql`plays`))
      .limit(take);

  const recent = await rank(
    and(listener, sql`${listens.playedAt} > now() - interval '7 days'`, accessClause),
    limit
  );
  const recentIds = recent.map((r) => r.trackId);

  let olderIds: string[] = [];
  if (recentIds.length < limit) {
    const older = await rank(
      and(
        listener,
        accessClause,
        recentIds.length ? notInArray(listens.trackId, recentIds) : undefined
      ),
      limit - recentIds.length
    );
    olderIds = older.map((r) => r.trackId);
  }

  const topIds = [...recentIds, ...olderIds];
  if (topIds.length === 0) return [];

  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(inArray(tracks.id, topIds));

  // inArray returns arbitrary order; restore the recent-then-older ranking.
  const byId = new Map(rows.map((r) => [r.track.id, r]));
  return topIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => r !== undefined)
    .map((r) =>
      toTrackDTO(r.track, r.track.ownerId === viewerId ? null : r.ownerName)
    );
}

/**
 * "Your top 100": the tracks the viewer played most, recent-first per the shared
 * recency rule (see topTracksByRecency). Access-filtered but NOT duplicate-hidden
 * (hideFriendDuplicates=false) — these are specific tracks you actually played, so
 * collapsing friend-copies would drop rows from your own history.
 */
export async function listTopTracks(userId: string): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  return topTracksByRecency({
    listenerIds: [userId],
    viewerId: userId,
    accessClause: accessWhere(userId, friendIds, false),
  });
}

/**
 * "Random": a small pool of random accessible tracks to seed the play-similar
 * radio. The client picks one per "Play Radio" tap, so the radio stays fresh
 * even when the page payload is cached by the router. Prefers tracks that
 * actually have an embedding (so the radio can engage); falls back to any
 * accessible tracks when none are analyzed yet. Excludes the viewer's "exclude
 * from Play Similar" tracks so the radio never starts on one. Returns [] when
 * the accessible library is empty.
 */
export async function randomSeedTracks(
  userId: string,
  hideFriendDuplicates: boolean,
  limit = 20
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const where = and(
    accessWhere(userId, friendIds, hideFriendDuplicates),
    notInArray(
      tracks.id,
      db
        .select({ id: similarExclusions.trackId })
        .from(similarExclusions)
        .where(eq(similarExclusions.userId, userId))
    )
  );

  let rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .innerJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(where)
    .orderBy(sql`random()`)
    .limit(limit);

  if (rows.length === 0) {
    rows = await db
      .select({ track: trackDtoColumns, ownerName: users.name })
      .from(tracks)
      .innerJoin(users, eq(tracks.ownerId, users.id))
      .where(where)
      .orderBy(sql`random()`)
      .limit(limit);
  }

  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * "Friends Top 100": your friends' most-played tracks, combined into one list and
 * ranked recent-first per the shared recency rule (see topTracksByRecency) —
 * plays are summed across all friends (a track two friends spin both counts).
 * Only tracks the viewer can access are included. Empty when the viewer has no
 * friends.
 */
export async function listFriendsTop(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  if (friendIds.length === 0) return [];
  return topTracksByRecency({
    listenerIds: friendIds,
    viewerId: userId,
    accessClause: accessWhere(userId, friendIds, hideFriendDuplicates),
  });
}

/**
 * "[Friend]'s Top 100": one friend's most-played tracks, recent-first per the
 * shared recency rule (see topTracksByRecency), filtered to what the *viewer* can
 * access. The caller must have verified friendship; the friend is then in the
 * viewer's friendIds, so the viewer's own access predicate correctly drops the
 * friend's private tracks and anything else the viewer can't reach.
 */
export async function listUserTopTracks(
  targetUserId: string,
  viewerId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(viewerId);
  return topTracksByRecency({
    listenerIds: [targetUserId],
    viewerId,
    accessClause: accessWhere(viewerId, friendIds, hideFriendDuplicates),
  });
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
