import {
  and,
  cosineDistance,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { trackEmbeddings, tracks, users } from "@/db/schema";
import { canAccessTrackWithFriends, friendIdsOf } from "@/lib/friends";
import {
  canonicalFriendCopy,
  notDuplicateOfOwn,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import type { TrackDTO } from "@/lib/types";

// "Play similar" variation level (users.similar_variation, 0..4) → Gumbel noise
// scale (sigma). 0 = very random, 4 = pure deterministic cosine. Sampling keys
// each candidate by `cosine + sigma * Gumbel`, then takes the top-k; with
// sigma 0 the noise vanishes and it degrades to deterministic top-k by cosine.
const SIGMA_BY_VARIATION = [1.2, 0.45, 0.2, 0.07, 0];

// Nearest-neighbour candidates pulled from pgvector before sampling. Sampling
// (for variation > 0) happens within this pool, so it bounds how far "very
// random" can roam — the top POOL_SIZE most-similar tracks, which keeps even
// random picks related. Far larger than any `limit`, and cheap (no vectors are
// transferred — pgvector ranks in-DB and returns only these rows).
const POOL_SIZE = 200;

/**
 * Tracks acoustically similar to a seed track, ranked by CLAP-embedding cosine
 * similarity, for the "play similar" radio. Honors the same access rule as the
 * library (own tracks + friends' non-private tracks, minus hidden duplicates),
 * so a result can never leak a track the viewer couldn't otherwise play.
 *
 * pgvector ranks the candidate pool in the database (`embedding <=> seed`), so
 * only POOL_SIZE rows come back — no embeddings cross the wire. The viewer's
 * `similar_variation` then controls how much randomness is mixed in (so the same
 * seed doesn't always produce the same run); repeats are avoided by excluding
 * the already-served ids. Returns [] when the seed is inaccessible or has no
 * embedding.
 */
export async function findSimilarTracks(
  userId: string,
  seedTrackId: string,
  { limit, excludeIds }: { limit: number; excludeIds: string[] }
): Promise<TrackDTO[]> {
  // All independent reads — including the viewer's friend ids, needed both for
  // the access check and the candidate query — run together, so the access
  // check is in-memory (no serial areFriends round-trip before the rest).
  const [seedRows, { hideFriendDuplicates, similarVariation }, friendIds] =
    await Promise.all([
      db
        .select({
          ownerId: tracks.ownerId,
          isPrivate: tracks.isPrivate,
          embedding: trackEmbeddings.embedding,
        })
        .from(tracks)
        .leftJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
        .where(eq(tracks.id, seedTrackId))
        .limit(1),
      getUserSettings(userId),
      friendIdsOf(userId),
    ]);

  const seed = seedRows[0];
  if (!seed || !seed.embedding) return [];
  if (!canAccessTrackWithFriends(userId, seed, friendIds)) return [];
  const seedVec = seed.embedding;
  const sigma = SIGMA_BY_VARIATION[similarVariation] ?? 0;

  // Cosine distance computed in-DB; ascending = most similar first.
  const distance = cosineDistance(trackEmbeddings.embedding, seedVec);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name, distance })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .innerJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(
      and(
        ne(tracks.id, seedTrackId),
        excludeIds.length ? notInArray(tracks.id, excludeIds) : undefined,
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
                hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
              )
            : sql`false`
        )
      )
    )
    .orderBy(distance)
    .limit(POOL_SIZE);

  // cosine distance (0..2) → similarity score, so larger = more similar.
  const scored = rows.map((r) => ({ r, score: 1 - Number(r.distance) }));
  const chosen = sampleTopK(scored, limit, sigma);
  return chosen.map(({ r }) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * Pick `k` items by descending `score + sigma * Gumbel(0,1)` (Gumbel-top-k =
 * sampling without replacement from softmax(score/sigma)). sigma 0 is exact
 * deterministic top-k by score, ties broken by id for stable pagination.
 */
function sampleTopK<T extends { r: { track: { id: string } } }>(
  scored: Array<T & { score: number }>,
  k: number,
  sigma: number
): Array<T & { score: number }> {
  if (sigma === 0) {
    return scored
      .sort(
        (a, b) => b.score - a.score || (a.r.track.id < b.r.track.id ? -1 : 1)
      )
      .slice(0, k);
  }
  return scored
    .map((s) => {
      // Gumbel(0,1) = -log(-log(U)); guard U away from 0 to avoid -Infinity.
      const u = Math.random() || Number.MIN_VALUE;
      return { s, key: s.score + sigma * -Math.log(-Math.log(u)) };
    })
    .sort((a, b) => b.key - a.key)
    .slice(0, k)
    .map((x) => x.s);
}
