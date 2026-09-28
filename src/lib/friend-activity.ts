import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { listens, tracks, users } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import {
  canonicalFriendCopy,
  isLibraryTrack,
  notDuplicateOfOwn,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import type { FriendActivityDTO } from "@/lib/types";
import { getUserSettings } from "@/lib/users";

/**
 * What the viewer's friends added and played in the last `days` days.
 * `recentlyAdded` is capped at `limit`; `topPlayed` holds up to `limit` tracks
 * per friend, friends ordered by their accessible plays in the window.
 * Play data is aggregate counts only, the same exposure as Discover's
 * Friends Top 100, and counts only listens of tracks the viewer can access
 * (so a friend's play of someone else's private track never surfaces).
 */
export async function getFriendActivity(
  userId: string,
  { days, limit }: { days: number; limit: number }
): Promise<FriendActivityDTO> {
  const friendIds = await friendIdsOf(userId);
  if (friendIds.length === 0) return { recentlyAdded: [], topPlayed: [] };

  const { hideFriendDuplicates } = await getUserSettings(userId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const friendTrackAccess = and(
    inArray(tracks.ownerId, friendIds),
    eq(tracks.isPrivate, false),
    hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
    hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
  );

  const listener = alias(users, "listener");
  const ranked = db
    .select({
      listenerId: listens.userId,
      trackId: listens.trackId,
      plays: sql<number>`count(*)::int`.as("plays"),
      listenerPlays:
        sql<number>`sum(count(*)) over (partition by ${listens.userId})`.as(
          "listener_plays"
        ),
      rn: sql<number>`row_number() over (
        partition by ${listens.userId}
        order by count(*) desc, ${listens.trackId}
      )`.as("rn"),
    })
    .from(listens)
    .innerJoin(tracks, eq(tracks.id, listens.trackId))
    .where(
      and(
        inArray(listens.userId, friendIds),
        gt(listens.playedAt, since),
        isLibraryTrack(),
        or(eq(tracks.ownerId, userId), friendTrackAccess)
      )
    )
    .groupBy(listens.userId, listens.trackId)
    .as("ranked");

  const [added, played] = await Promise.all([
    db
      .select({ track: trackDtoColumns, ownerName: users.name })
      .from(tracks)
      .innerJoin(users, eq(tracks.ownerId, users.id))
      .where(
        and(isLibraryTrack(), friendTrackAccess, gt(tracks.createdAt, since))
      )
      .orderBy(desc(tracks.createdAt), desc(tracks.id))
      .limit(limit),
    db
      .select({
        listenerId: ranked.listenerId,
        listenerName: listener.name,
        plays: ranked.plays,
        track: trackDtoColumns,
        ownerName: users.name,
      })
      .from(ranked)
      .innerJoin(tracks, eq(tracks.id, ranked.trackId))
      .innerJoin(users, eq(tracks.ownerId, users.id))
      .innerJoin(listener, eq(listener.id, ranked.listenerId))
      .where(lte(ranked.rn, limit))
      .orderBy(desc(ranked.listenerPlays), asc(ranked.listenerId), asc(ranked.rn)),
  ]);

  const topPlayed: FriendActivityDTO["topPlayed"] = [];
  for (const row of played) {
    let entry = topPlayed.at(-1);
    if (entry?.friend.id !== row.listenerId) {
      entry = { friend: { id: row.listenerId, name: row.listenerName }, tracks: [] };
      topPlayed.push(entry);
    }
    entry.tracks.push({
      track: toTrackDTO(
        row.track,
        row.track.ownerId === userId ? null : row.ownerName
      ),
      plays: row.plays,
    });
  }

  return {
    recentlyAdded: added.map((r) => toTrackDTO(r.track, r.ownerName)),
    topPlayed,
  };
}
