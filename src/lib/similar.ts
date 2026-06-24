import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { trackEmbeddings, tracks, users } from "@/db/schema";
import { canAccessTrack, friendIdsOf } from "@/lib/friends";
import { notDuplicateOfOwn, toTrackDTO } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import type { TrackDTO } from "@/lib/types";

// "Play similar" variation level (users.similar_variation, 0..4) → Gumbel noise
// scale (sigma). 0 = very random, 4 = pure deterministic cosine. Sampling keys
// each candidate by `cosine + sigma * Gumbel`, then takes the top-k; with
// sigma 0 the noise vanishes and it degrades to deterministic top-k by cosine.
// Sigma is on the scale of cosine similarities (CLAP cosines span ~0.3–0.9), so
// at "default" the noise meaningfully reshuffles among similar tracks while the
// far-less-similar ones still rarely win.
const SIGMA_BY_VARIATION = [1.2, 0.45, 0.2, 0.07, 0];

/**
 * Tracks acoustically similar to a seed track, ranked by CLAP-embedding cosine
 * similarity, for the "play similar" radio. Honors the same access rule as the
 * library (own tracks + friends' non-private tracks, minus hidden duplicates),
 * so a result can never leak a track the viewer couldn't otherwise play.
 *
 * The viewer's `similar_variation` setting controls how much randomness is
 * mixed in (so the same seed doesn't always produce the same run). Repeats are
 * avoided by passing the already-served ids in `excludeIds`. Returns [] when the
 * seed is inaccessible or has no embedding. Brute-force in JS is fine at
 * personal-library scale (hundreds–low thousands of tracks).
 */
export async function findSimilarTracks(
  userId: string,
  seedTrackId: string,
  { limit, excludeIds }: { limit: number; excludeIds: string[] }
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

  const { hideFriendDuplicates, similarVariation } =
    await getUserSettings(userId);
  const sigma = SIGMA_BY_VARIATION[similarVariation] ?? 0;
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

  const exclude = new Set(excludeIds);
  const scored = rows
    .filter((r) => !exclude.has(r.track.id))
    .map((r) => ({ r, score: dot(seedVec, r.embedding) }));

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

/** Dot product; equals cosine because CLAP embeddings are stored L2-normalized. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
