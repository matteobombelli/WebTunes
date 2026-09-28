import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { listens, tracks, users } from "@/db/schema";
import { canAccessTrack, friendIdsOf } from "@/lib/friends";
import { listenQualificationSeconds } from "@/lib/listen-telemetry";
import {
  encodeTrackCursor,
  isLibraryTrack,
  parseTrackCursor,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import type { ListenHistoryDTO } from "@/lib/types";

type ListenTelemetry = {
  sessionId: string;
  listenedSeconds: number;
  durationSeconds: number;
};

type RecordListenResult =
  | "ok"
  | "not_found"
  | "forbidden"
  | "not_qualified";

/**
 * Record a qualified play. Telemetry checkpoints update one session row with
 * the greatest cumulative duration received, so retries and out-of-order
 * requests are idempotent. The stored track duration is authoritative; the
 * client's media duration only covers older tracks whose duration is missing.
 */
export async function recordListen(
  userId: string,
  trackId: string,
  telemetry: ListenTelemetry
): Promise<RecordListenResult> {
  const [track] = await db
    .select({
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
      suggestedImportId: tracks.suggestedImportId,
      durationSec: tracks.durationSec,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId));
  if (!track) return "not_found";
  // Previewing staged recommendations must not affect Top 100 or analytics.
  // The dedicated suggestion access rule already proved ownership before the
  // player reached this endpoint, so acknowledge telemetry without storing it.
  if (track.suggestedImportId) {
    return track.ownerId === userId ? "ok" : "forbidden";
  }
  if (!(await canAccessTrack(userId, track))) return "forbidden";

  const qualifySeconds = listenQualificationSeconds(
    track.durationSec ?? telemetry.durationSeconds
  );
  if (
    qualifySeconds == null ||
    telemetry.listenedSeconds < qualifySeconds
  ) {
    return "not_qualified";
  }

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(listens)
      .values({
        userId,
        trackId,
        sessionId: telemetry.sessionId,
        listenedSeconds: telemetry.listenedSeconds,
      })
      .onConflictDoNothing({ target: listens.sessionId })
      .returning({ id: listens.id });

    if (inserted.length) {
      // A telemetry session contributes to the owner-excluded friend counter
      // exactly once, when its listen row first qualifies at 50% playback.
      if (track.ownerId !== userId) {
        await tx
          .update(tracks)
          .set({ friendPlayCount: sql`${tracks.friendPlayCount} + 1` })
          .where(eq(tracks.id, trackId));
      }
      return;
    }

    // The session id is unguessable, but still scope the update to its original
    // user + track so a collision can never mutate someone else's history.
    await tx
      .update(listens)
      .set({
        listenedSeconds: sql`greatest(coalesce(${listens.listenedSeconds}, ${telemetry.listenedSeconds}), ${telemetry.listenedSeconds})`,
      })
      .where(
        and(
          eq(listens.sessionId, telemetry.sessionId),
          eq(listens.userId, userId),
          eq(listens.trackId, trackId)
        )
      );
  });

  return "ok";
}

export type ListenCursor = { playedAt: string; id: string };

/** Validate a `nextBefore` value from listListenHistory; null if malformed. */
export function parseListenCursor(value: string): ListenCursor | null {
  const cursor = parseTrackCursor(value);
  return cursor && { playedAt: cursor.createdAt, id: cursor.id };
}

function beforeListenCursor(cursor?: ListenCursor) {
  if (!cursor) return undefined;
  const time = sql`cast(${cursor.playedAt} as timestamp)`;
  return or(
    lt(listens.playedAt, time),
    and(eq(listens.playedAt, time), lt(listens.id, cursor.id))
  );
}

/**
 * The viewer's own listens, newest first, limited to tracks they can still
 * access. `from` is inclusive, `to` exclusive. Keyset-paged on
 * (playedAt, id) at microsecond precision, so listens sharing a timestamp are
 * never skipped at a page boundary. Stats-excluded legacy rows are included.
 */
export async function listListenHistory(
  userId: string,
  opts: { from?: Date; to?: Date; limit: number; before?: ListenCursor }
): Promise<ListenHistoryDTO> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({
      id: listens.id,
      playedAt: listens.playedAt,
      cursorPlayedAt: sql<string>`${listens.playedAt}::text`,
      listenedSeconds: listens.listenedSeconds,
      track: trackDtoColumns,
      ownerName: users.name,
    })
    .from(listens)
    .innerJoin(tracks, eq(tracks.id, listens.trackId))
    .innerJoin(users, eq(users.id, tracks.ownerId))
    .where(
      and(
        eq(listens.userId, userId),
        opts.from ? gte(listens.playedAt, opts.from) : undefined,
        opts.to ? lt(listens.playedAt, opts.to) : undefined,
        beforeListenCursor(opts.before),
        isLibraryTrack(),
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
    .orderBy(desc(listens.playedAt), desc(listens.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      track: toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName),
      playedAt: r.playedAt.toISOString(),
      listenedSeconds: r.listenedSeconds,
    })),
    nextBefore:
      rows.length > opts.limit && last
        ? encodeTrackCursor({ createdAt: last.cursorPlayedAt, id: last.id })
        : null,
  };
}
