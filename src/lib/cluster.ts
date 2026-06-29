/**
 * Spherical k-means + automatic-K selection for the "Recommended" feed.
 *
 * Operates on the viewer's top-N CLAP embeddings (512-d, already L2-normalized,
 * so cosine similarity is a plain dot product). Pure and dependency-free — no
 * DB or I/O. The randomness (k-means++ seeding, restarts) is driven by a PRNG
 * seeded deterministically from the seed-track ids, so a given taste profile
 * always clusters the same way and only re-derives when the top-N changes. That
 * keeps the `similar_variation = 4` "pure deterministic" contract intact:
 * downstream Gumbel sampling is the only source of run-to-run variation, never
 * the clustering here.
 */

/** mulberry32: tiny fast deterministic PRNG, floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of the sorted ids → a u32 PRNG seed (order-independent). */
function hashIds(ids: string[]): number {
  let h = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c; // ',' separator so ["ab","c"] hashes apart from ["a","bc"]
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Dot product. For unit vectors this is cosine similarity; 1 − dot is cosine distance. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** L2-normalize to unit length (returns the input unchanged if it's the zero vector). */
function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n > 0 ? v.map((x) => x / n) : v;
}

export type ClusterResult = { centroids: number[][]; assignments: number[] };

/**
 * k-means++ seeding under cosine distance (1 − dot): first centroid uniform at
 * random, each subsequent one sampled with probability ∝ D² to its nearest
 * chosen centroid. May return fewer than `k` if all points coincide.
 */
function kmeansppInit(
  vectors: number[][],
  k: number,
  rng: () => number
): number[][] {
  const n = vectors.length;
  const centroids: number[][] = [[...vectors[Math.floor(rng() * n)]]];
  // Nearest-centroid distance per point; updated as centroids are added.
  const minDist = vectors.map((v) => 1 - dot(v, centroids[0]));

  while (centroids.length < k) {
    let total = 0;
    for (const d of minDist) total += d * d;
    if (total === 0) break; // every point already sits on a centroid
    let target = rng() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= minDist[i] * minDist[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    const c = [...vectors[chosen]];
    centroids.push(c);
    for (let i = 0; i < n; i++) {
      const d = 1 - dot(vectors[i], c);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  return centroids;
}

/** Drop clusters with no members, renumbering assignments to stay contiguous. */
function dropEmpty(centroids: number[][], assignments: number[]): ClusterResult {
  const used = new Set(assignments);
  const remap = new Map<number, number>();
  const kept: number[][] = [];
  for (let c = 0; c < centroids.length; c++) {
    if (used.has(c)) {
      remap.set(c, kept.length);
      kept.push(centroids[c]);
    }
  }
  return { centroids: kept, assignments: assignments.map((c) => remap.get(c)!) };
}

/**
 * Spherical k-means: Lloyd's algorithm with cosine assignment (max dot product)
 * and centroids re-normalized to unit length each iteration. Re-normalizing is
 * what keeps cosine assignment correct — arithmetic means don't share magnitude.
 * Runs `restarts` times and keeps the lowest within-cluster cosine inertia.
 * Empty clusters are dropped, so the returned centroid count may be < `k`.
 */
export function sphericalKMeans(
  vectors: number[][],
  k: number,
  rng: () => number,
  { restarts = 4, maxIters = 25 }: { restarts?: number; maxIters?: number } = {}
): ClusterResult {
  const n = vectors.length;
  const dim = vectors[0].length;

  let best: ClusterResult | null = null;
  let bestInertia = Infinity;

  for (let attempt = 0; attempt < restarts; attempt++) {
    const centroids = kmeansppInit(vectors, k, rng);
    const assignments = new Array<number>(n).fill(0);

    for (let iter = 0; iter < maxIters; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bestC = 0;
        let bestDot = -Infinity;
        for (let c = 0; c < centroids.length; c++) {
          const d = dot(vectors[i], centroids[c]);
          if (d > bestDot) {
            bestDot = d;
            bestC = c;
          }
        }
        if (assignments[i] !== bestC) {
          assignments[i] = bestC;
          changed = true;
        }
      }

      const sums = Array.from({ length: centroids.length }, () =>
        new Array<number>(dim).fill(0)
      );
      const counts = new Array<number>(centroids.length).fill(0);
      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        counts[c]++;
        const s = sums[c];
        const v = vectors[i];
        for (let j = 0; j < dim; j++) s[j] += v[j];
      }
      for (let c = 0; c < centroids.length; c++) {
        if (counts[c] > 0) centroids[c] = normalize(sums[c]); // else keep prior
      }

      if (!changed) break;
    }

    const result = dropEmpty(centroids, assignments);
    let inertia = 0;
    for (let i = 0; i < n; i++) {
      inertia += 1 - dot(vectors[i], result.centroids[result.assignments[i]]);
    }
    if (inertia < bestInertia) {
      bestInertia = inertia;
      best = result;
    }
  }

  return best!;
}

/** Symmetric n×n cosine-distance (1 − dot) matrix; computed once, reused per K. */
function cosineDistanceMatrix(vectors: number[][]): number[][] {
  const n = vectors.length;
  const m = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(vectors[i], vectors[j]);
      m[i][j] = d;
      m[j][i] = d;
    }
  }
  return m;
}

/**
 * Mean silhouette over a clustering, using a precomputed cosine-distance matrix.
 * s(i) = (b − a) / max(a, b) where a is mean intra-cluster distance and b is the
 * min mean distance to any other cluster; singleton clusters contribute 0 by
 * convention. Result is in [−1, 1]; higher means tighter, better-separated clusters.
 */
function meanSilhouette(
  dist: number[][],
  assignments: number[],
  k: number
): number {
  const n = assignments.length;
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[assignments[i]].push(i);

  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = members[assignments[i]];
    if (own.length <= 1) continue; // singleton → s(i) = 0

    let a = 0;
    for (const j of own) if (j !== i) a += dist[i][j];
    a /= own.length - 1;

    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === assignments[i] || members[c].length === 0) continue;
      let mean = 0;
      for (const j of members[c]) mean += dist[i][j];
      mean /= members[c].length;
      if (mean < b) b = mean;
    }
    if (b === Infinity) continue; // no other non-empty cluster → s(i) = 0

    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

/**
 * Choose K automatically and return that K's unit centroids, or `null` to signal
 * the single-centroid fallback. K is the value in 2..min(kMax, ⌊n/2⌋) with the
 * highest mean cosine silhouette. Returns `null` when there are too few seeds
 * (`n < minSeeds`), no valid K range, or the best silhouette is below
 * `minSilhouette` (the embeddings show no real cluster structure — don't
 * over-cluster a homogeneous library). Deterministic for a given `ids` set.
 */
export function autoClusterCentroids(
  vectors: number[][],
  ids: string[],
  {
    kMax = 8,
    minSeeds = 8,
    minSilhouette = 0.1,
    restarts = 4,
    maxIters = 25,
  }: {
    kMax?: number;
    minSeeds?: number;
    minSilhouette?: number;
    restarts?: number;
    maxIters?: number;
  } = {}
): number[][] | null {
  const n = vectors.length;
  if (n < minSeeds) return null;

  const maxK = Math.min(kMax, Math.floor(n / 2));
  if (maxK < 2) return null;

  const dist = cosineDistanceMatrix(vectors);
  const rng = mulberry32(hashIds(ids));

  let best: { centroids: number[][]; score: number } | null = null;
  for (let k = 2; k <= maxK; k++) {
    const { centroids, assignments } = sphericalKMeans(vectors, k, rng, {
      restarts,
      maxIters,
    });
    if (centroids.length < 2) continue; // collapsed to one usable cluster
    const score = meanSilhouette(dist, assignments, centroids.length);
    if (!best || score > best.score) best = { centroids, score };
  }

  if (!best || best.score < minSilhouette) return null;
  return best.centroids;
}
