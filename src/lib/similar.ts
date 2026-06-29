import {
  and,
  cosineDistance,
  eq,
  inArray,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { similarExclusions, trackEmbeddings, tracks, users } from "@/db/schema";
import { autoClusterCentroids } from "@/lib/cluster";
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
  {
    limit,
    excludeIds,
    withinIds,
  }: { limit: number; excludeIds: string[]; withinIds?: string[] }
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

  // The seed itself is just another excluded id — folds into the same NOT IN.
  // `withinIds` (when given) limits ranking to a candidate set — used by
  // Discover to keep a tapped song's mix inside the section it came from.
  return rankAccessibleByVector(userId, seed.embedding, {
    limit,
    excludeIds: [seedTrackId, ...excludeIds],
    sigma: SIGMA_BY_VARIATION[similarVariation] ?? 0,
    friendIds,
    hideFriendDuplicates,
    withinIds,
  });
}

/**
 * "Recommended": cluster the viewer's top-N seed embeddings into K acoustic
 * groups (K auto-chosen by silhouette in `lib/cluster.ts`) and draft `limit`
 * tracks round-robin across the clusters. Consecutive results come from
 * different clusters, so the Discover album-art grid alternates and the feed
 * spans the viewer's whole taste instead of one averaged centroid. Falls back to
 * the single mean centroid (the previous behavior) when there are too few seeds
 * or the embeddings show no real cluster structure. The seeds (and any extra
 * `excludeIds`) are excluded from the results. Returns [] when none of the seeds
 * has an embedding yet.
 */
export async function findRecommendedClusters(
  userId: string,
  seedTrackIds: string[],
  { limit, excludeIds = [] }: { limit: number; excludeIds?: string[] }
): Promise<TrackDTO[]> {
  if (seedTrackIds.length === 0) return [];

  const [seedRows, { hideFriendDuplicates, similarVariation }, friendIds] =
    await Promise.all([
      db
        .select({ embedding: trackEmbeddings.embedding })
        .from(trackEmbeddings)
        .where(
          and(
            inArray(trackEmbeddings.trackId, seedTrackIds),
            // Excluded "play similar" tracks don't seed the recommendation
            // either (the result query already drops them); mirrors Random.
            notInArray(
              trackEmbeddings.trackId,
              db
                .select({ id: similarExclusions.trackId })
                .from(similarExclusions)
                .where(eq(similarExclusions.userId, userId))
            )
          )
        ),
      getUserSettings(userId),
      friendIdsOf(userId),
    ]);
  if (seedRows.length === 0) return []; // none analyzed yet

  const embeddings = seedRows.map((r) => r.embedding);
  const shared = {
    excludeIds: [...seedTrackIds, ...excludeIds],
    sigma: SIGMA_BY_VARIATION[similarVariation] ?? 0,
    friendIds,
    hideFriendDuplicates,
  };

  const centroids = autoClusterCentroids(embeddings, seedTrackIds);

  // No usable cluster structure (too few seeds / homogeneous library) → fall
  // back to the single mean centroid, the prior "Recommended" behavior.
  // cosineDistance normalizes both operands, so the mean's magnitude is
  // irrelevant to ranking — no re-normalization needed.
  if (!centroids) {
    const dim = embeddings[0].length; // 512
    const mean = new Array<number>(dim).fill(0);
    for (const v of embeddings) for (let i = 0; i < dim; i++) mean[i] += v[i];
    for (let i = 0; i < dim; i++) mean[i] /= embeddings.length;
    return rankAccessibleByVector(userId, mean, { limit, ...shared });
  }

  // One ranked pool per cluster — request the full POOL_SIZE so the draft has
  // headroom to reach `limit` after cross-cluster dedup. K ≤ 8 cheap HNSW
  // queries; no embeddings cross the wire (pgvector ranks in-DB).
  const lists = await Promise.all(
    centroids.map((c) =>
      rankAccessibleByVector(userId, c, { limit: POOL_SIZE, ...shared })
    )
  );
  return draftRoundRobin(lists, limit);
}

/**
 * Round-robin draft across per-cluster ranked lists: cycle the clusters, each
 * contributing its best not-yet-chosen track (deduped by id), until `limit` are
 * chosen or every pool is exhausted. Advancing the cluster on each pick makes
 * consecutive results come from different clusters (1,2,…,K,1,2,…) until only one
 * non-exhausted cluster remains. The server returns this order verbatim, so the
 * Discover album-art grid alternates clusters.
 */
function draftRoundRobin(lists: TrackDTO[][], limit: number): TrackDTO[] {
  const ptr = new Array<number>(lists.length).fill(0);
  const chosen = new Set<string>();
  const result: TrackDTO[] = [];

  let progressed = true;
  while (result.length < limit && progressed) {
    progressed = false;
    for (let c = 0; c < lists.length && result.length < limit; c++) {
      const list = lists[c];
      // Skip tracks an earlier cluster already drafted this round.
      while (ptr[c] < list.length && chosen.has(list[ptr[c]].id)) ptr[c]++;
      if (ptr[c] >= list.length) continue; // this pool is exhausted
      const track = list[ptr[c]++];
      chosen.add(track.id);
      result.push(track);
      progressed = true;
    }
  }
  return result;
}

/**
 * Shared candidate query for vector-based discovery: rank accessible tracks by
 * cosine similarity to `queryVec`, honoring the same access rule as the library
 * (own + friends' non-private minus hidden duplicates) AND the viewer's
 * "exclude from Play Similar" list, then Gumbel-top-k sample by `sigma`. Both
 * the single-seed radio and the centroid "Recommended" feed go through here, so
 * the exclusion/access rules can never diverge between them.
 */
async function rankAccessibleByVector(
  userId: string,
  queryVec: number[],
  opts: {
    limit: number;
    excludeIds: string[];
    sigma: number;
    friendIds: string[];
    hideFriendDuplicates: boolean;
    /** When set, restrict ranking to this candidate set (limited-context). */
    withinIds?: string[];
  }
): Promise<TrackDTO[]> {
  const { limit, excludeIds, sigma, friendIds, hideFriendDuplicates, withinIds } =
    opts;

  // Cosine distance computed in-DB; ascending = most similar first.
  const distance = cosineDistance(trackEmbeddings.embedding, queryVec);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name, distance })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .innerJoin(trackEmbeddings, eq(trackEmbeddings.trackId, tracks.id))
    .where(
      and(
        withinIds && withinIds.length
          ? inArray(tracks.id, withinIds)
          : undefined,
        excludeIds.length ? notInArray(tracks.id, excludeIds) : undefined,
        // Drop tracks the viewer has excluded from their Play Similar feed. A
        // subselect (unlike an empty array) is always safe — no length guard —
        // and trackId is NOT NULL so NOT IN can't collapse to "no rows pass".
        notInArray(
          tracks.id,
          db
            .select({ id: similarExclusions.trackId })
            .from(similarExclusions)
            .where(eq(similarExclusions.userId, userId))
        ),
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
