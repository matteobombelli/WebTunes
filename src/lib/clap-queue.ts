import { db } from "@/db";
import { trackEmbeddings } from "@/db/schema";
import { embedTrack } from "@/lib/clap-embedding";
import { getObjectBytes } from "@/lib/s3";

// Background queue for CLAP embeddings. On upload we no longer block the request
// on the embedding (ffmpeg decode + ONNX inference, the slowest upload step) —
// the route enqueues a tiny job here and returns, and these workers fill in the
// `track_embeddings` row a few seconds later. Best-effort, exactly like the
// inline path was: any failure leaves the track without an embedding, and the
// missing-row backstop (`scripts/analyze-clap-embeddings.mjs`) recovers it.
//
// Jobs hold only ids/keys, not audio bytes: the worker re-fetches the stored
// bytes from S3 when it runs, so a burst of uploads can't pile up 100 MB buffers
// in the queue — at most MAX_WORKERS decodes are in flight. (Embedding the
// stored bytes also matches the backfill script, which downloads the same S3
// object.) `embedTrack` keeps its own inference gate, so two workers never
// oversubscribe the model.

type Job = { trackId: string; s3Key: string; ext: string };

const MAX_WORKERS = 2;
const queue: Job[] = [];
let workers = 0;

/** Queue a track for background CLAP embedding. Returns immediately. */
export function enqueueEmbedding(job: Job): void {
  queue.push(job);
  if (workers < MAX_WORKERS) {
    workers++;
    void runWorker();
  }
}

async function runWorker(): Promise<void> {
  try {
    let job: Job | undefined;
    while ((job = queue.shift())) {
      await processJob(job);
    }
  } finally {
    workers--;
  }
}

async function processJob(job: Job): Promise<void> {
  try {
    const bytes = await getObjectBytes(job.s3Key);
    const embedding = await embedTrack(bytes, job.ext);
    if (!embedding) return; // best-effort: backfill script recovers it later
    await db
      .insert(trackEmbeddings)
      .values({ trackId: job.trackId, embedding })
      // A racing backfill (or a re-enqueue) may have inserted it already.
      .onConflictDoNothing();
  } catch {
    // Swallow: a missing embedding row is the documented best-effort outcome.
  }
}
