import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { listens, tracks } from "@/db/schema";
import { canAccessTrack } from "@/lib/friends";
import { listenQualificationSeconds } from "@/lib/listen-telemetry";

export type ListenTelemetry = {
  sessionId: string;
  listenedSeconds: number;
  durationSeconds: number;
};

export type RecordListenResult =
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
