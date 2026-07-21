import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { listens, tracks } from "@/db/schema";
import { canAccessTrack } from "@/lib/friends";

export type ListenTelemetry = {
  sessionId: string;
  listenedSeconds: number;
};

export type RecordListenResult = "ok" | "not_found" | "forbidden";

/**
 * Record a qualified play. Telemetry checkpoints update one session row with
 * the greatest cumulative duration received, so retries and out-of-order
 * requests are idempotent. A body-less legacy client still inserts one row.
 */
export async function recordListen(
  userId: string,
  trackId: string,
  telemetry: ListenTelemetry | null
): Promise<RecordListenResult> {
  const [track] = await db
    .select({
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
      suggestedImportId: tracks.suggestedImportId,
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

  await db.transaction(async (tx) => {
    if (!telemetry) {
      await tx.insert(listens).values({ userId, trackId });
      if (track.ownerId !== userId) {
        await tx
          .update(tracks)
          .set({ friendPlayCount: sql`${tracks.friendPlayCount} + 1` })
          .where(eq(tracks.id, trackId));
      }
      return;
    }

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
      // exactly once, when its listen row is first created at the 30s mark.
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
        listenedSeconds: sql`greatest(coalesce(${listens.listenedSeconds}, 30), ${telemetry.listenedSeconds})`,
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
