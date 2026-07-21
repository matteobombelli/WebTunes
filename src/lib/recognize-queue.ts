import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { trackIdentities, tracks } from "@/db/schema";
import { log } from "@/lib/log";
import {
  fingerprint,
  lookupAcoustId,
  resolveArt,
  type Recognition,
} from "@/lib/recognize";
import { deleteObject, getObjectBytes, uploadObject } from "@/lib/s3";
import {
  makeThumbnail,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_EXT,
} from "@/lib/thumbnail";

// Background queue that fills MISSING artist/album/cover-art for a track via
// acoustic fingerprinting (lib/recognize.ts) - AcoustID/Chromaprint + Cover Art
// Archive, with the iTunes lookup as the art fallback. Enqueued from the upload
// route after the row exists, exactly like the CLAP embedding queue: a tiny
// {trackId,s3Key,ext} job, bytes re-fetched from S3 when the worker runs (so an
// upload burst can't pile big buffers in the queue), best-effort - any failure
// just leaves the gaps for the backfill script.
//
// It NEVER overwrites existing data: it re-reads the row and every write is a
// conditional `WHERE <col> IS NULL` UPDATE, so a value set between enqueue and
// run (or by a concurrent backfill) is never clobbered. The title is never
// touched.
//
// MAX_WORKERS = 1: unlike CLAP (CPU-local, no external limit, 2 workers), this
// queue is gated by external politeness - AcoustID ≤3 req/s and Cover Art
// Archive/MusicBrainz ≤1 req/s on a single shared app key. One serial worker
// stays under all of them with zero cross-worker coordination, and recognition
// isn't latency-sensitive (it backfills metadata seconds after the upload).

type Job = { trackId: string; s3Key: string; ext: string };

const MAX_WORKERS = 1;
const queue: Job[] = [];
const queuedTrackIds = new Set<string>();
let workers = 0;

/** Queue a track for background metadata recognition. Returns immediately. */
export function enqueueRecognition(job: Job): void {
  if (queuedTrackIds.has(job.trackId)) return;
  queuedTrackIds.add(job.trackId);
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
      try {
        await processJob(job);
      } finally {
        queuedTrackIds.delete(job.trackId);
      }
    }
  } finally {
    workers--;
  }
}

async function processJob(job: Job): Promise<void> {
  try {
    // Re-read the current row: fields may have been filled between enqueue and
    // now, and we only ever touch ones that are still empty.
    const [row] = await db
      .select({
        ownerId: tracks.ownerId,
        title: tracks.title,
        artist: tracks.artist,
        album: tracks.album,
        artS3Key: tracks.artS3Key,
        identityStatus: trackIdentities.status,
        acoustidId: trackIdentities.acoustidId,
        recordingMbid: trackIdentities.recordingMbid,
        artistMbids: trackIdentities.artistMbids,
        releaseGroupMbid: trackIdentities.releaseGroupMbid,
        retryAfter: trackIdentities.retryAfter,
      })
      .from(tracks)
      .leftJoin(trackIdentities, eq(trackIdentities.trackId, tracks.id))
      .where(eq(tracks.id, job.trackId));
    if (!row) return; // deleted since enqueue

    const needArtist = !row.artist;
    const needAlbum = !row.album;
    const needArt = !row.artS3Key;
    const needIdentity =
      !row.identityStatus ||
      (row.identityStatus !== "recognized" &&
        (!row.retryAfter || row.retryAfter.getTime() <= Date.now()));
    if (!needArtist && !needAlbum && !needArt && !needIdentity) return;

    // Fingerprint + AcoustID only when a key is configured. Without one we skip
    // straight to the iTunes art fallback below (for tracks that already have an
    // artist but no cover) and never write artist/album.
    let rec: Recognition | null =
      row.identityStatus === "recognized" && row.recordingMbid
        ? {
            acoustidId: row.acoustidId ?? "",
            recordingMbid: row.recordingMbid,
            artistMbids: row.artistMbids ?? [],
            artist: row.artist,
            album: row.album,
            releaseGroupMbid: row.releaseGroupMbid,
          }
        : null;
    if (needIdentity && process.env.ACOUSTID_API_KEY) {
      const bytes = await getObjectBytes(job.s3Key);
      const fp = await fingerprint(bytes, job.ext);
      if (fp) rec = await lookupAcoustId(fp);
      const retryAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db
        .insert(trackIdentities)
        .values(
          rec
            ? {
                trackId: job.trackId,
                status: "recognized",
                acoustidId: rec.acoustidId,
                recordingMbid: rec.recordingMbid,
                artistMbids: rec.artistMbids,
                releaseGroupMbid: rec.releaseGroupMbid,
                attemptedAt: new Date(),
                retryAfter: null,
              }
            : {
                trackId: job.trackId,
                status: fp ? "unmatched" : "failed",
                attemptedAt: new Date(),
                retryAfter,
              }
        )
        .onConflictDoUpdate({
          target: trackIdentities.trackId,
          set: rec
            ? {
                status: "recognized",
                acoustidId: rec.acoustidId,
                recordingMbid: rec.recordingMbid,
                artistMbids: rec.artistMbids,
                releaseGroupMbid: rec.releaseGroupMbid,
                attemptedAt: new Date(),
                retryAfter: null,
              }
            : {
                status: fp ? "unmatched" : "failed",
                attemptedAt: new Date(),
                retryAfter,
              },
        });
    }

    // Conditional, no-overwrite writes - the `IS NULL` guard makes the
    // "never overwrite existing data" rule atomic at the DB.
    if (needArtist && rec?.artist) {
      await db
        .update(tracks)
        .set({ artist: rec.artist })
        .where(and(eq(tracks.id, job.trackId), isNull(tracks.artist)));
    }
    if (needAlbum && rec?.album) {
      await db
        .update(tracks)
        .set({ album: rec.album })
        .where(and(eq(tracks.id, job.trackId), isNull(tracks.album)));
    }

    if (needArt) {
      // Prefer the freshly-recognized artist/album, else the row's existing tags
      // so the iTunes fallback still works for a no-key / already-tagged track.
      const art = await resolveArt({
        mbid: rec?.releaseGroupMbid ?? null,
        artist: rec?.artist ?? row.artist,
        album: rec?.album ?? row.album,
        title: row.title,
      });
      if (art) {
        // Recognition-specific `.rec.` keys, disjoint from the manual-upload
        // scheme (`art/{owner}/{id}.{ext}` / `….thumb.jpg`): art the owner
        // uploads while we're out fingerprinting must not be clobbered. The
        // row is claimed only AFTER the objects exist (leak beats dangling);
        // a lost claim deletes them best-effort (reconcile script backstops).
        const artKey = `art/${row.ownerId}/${job.trackId}.rec.${art.kind.ext}`;
        await uploadObject(artKey, art.body, art.kind.contentType);
        const thumb = await makeThumbnail(art.body, art.kind.ext);
        const thumbKey = thumb
          ? `art/${row.ownerId}/${job.trackId}.rec.${THUMBNAIL_EXT}`
          : null;
        if (thumb && thumbKey) {
          await uploadObject(thumbKey, thumb, THUMBNAIL_CONTENT_TYPE);
        }
        const claimed = await db
          .update(tracks)
          .set({ artS3Key: artKey, artThumbS3Key: thumbKey })
          .where(and(eq(tracks.id, job.trackId), isNull(tracks.artS3Key)))
          .returning({ id: tracks.id });
        if (claimed.length === 0) {
          await deleteObject(artKey).catch(() => {});
          if (thumbKey) await deleteObject(thumbKey).catch(() => {});
        }
      }
    }
  } catch (err) {
    // A missing fill is the documented best-effort outcome; surface infra
    // failures (S3 / DB) to the journal so they're diagnosable.
    log.warn(
      "recognize",
      `job failed ${job.trackId}`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
