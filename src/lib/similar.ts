import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { trackEmbeddings, tracks, users } from "@/db/schema";
import { canAccessTrack, friendIdsOf } from "@/lib/friends";
import { notDuplicateOfOwn, toTrackDTO } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import type { TrackDTO } from "@/lib/types";

/**
 * Tracks acoustically similar to a seed track, ranked by CLAP-embedding cosine
 * similarity, for the "play similar" radio. Honors the same access rule as the
 * library (own tracks + friends' non-private tracks, minus hidden duplicates),
 * so a result can never leak a track the viewer couldn't otherwise play.
 *
 * Ranking is deterministic (cosine desc, ties broken by id), so the client
 * paginates with a growing `offset` to pull fresh, non-repeating batches
 * without sending an exclude list. Returns [] when the seed is inaccessible or
 * has no embedding (nothing to seed from). Brute-force cosine in JS is fine at
 * personal-library scale (hundreds–low thousands of tracks).
 */
export async function findSimilarTracks(
  userId: string,
  seedTrackId: string,
  { limit, offset }: { limit: number; offset: number }
): Promise<TrackDTO[]> {
  const [seed] = await db
    .select({
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
      embedding: trackEmbeddings.embedding,
    })
    .from(tracks)
    .leftJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(eq(tracks.id, seedTrackId))
    .limit(1);

  if (!seed || !seed.embedding) return [];
  if (!(await canAccessTrack(userId, seed))) return [];
  const seedVec = seed.embedding;

  const { hideFriendDuplicates } = await getUserSettings(userId);
  const friendIds = await friendIdsOf(userId);

  // Inner-join the embedding table so only embedded tracks are candidates.
  const rows = await db
    .select({
      track: tracks,
      ownerName: users.name,
      embedding: trackEmbeddings.embedding,
    })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .innerJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(
      and(
        ne(tracks.id, seedTrackId),
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined
              )
            : sql`false`
        )
      )
    );

  const scored = rows
    .map((r) => ({ r, score: dot(seedVec, r.embedding) }))
    .sort((a, b) => b.score - a.score || (a.r.track.id < b.r.track.id ? -1 : 1));

  return scored
    .slice(offset, offset + limit)
    .map(({ r }) =>
      toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
    );
}

/** Dot product; equals cosine because CLAP embeddings are stored L2-normalized. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
