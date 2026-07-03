import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, isUniqueViolation } from "@/db";
import { tracks, type Track } from "@/db/schema";
import { fetchCoverArt } from "@/lib/art-fetch";
import { enqueueEmbedding } from "@/lib/clap-queue";
import { imageKindFromMime } from "@/lib/image-upload";
import { log } from "@/lib/log";
import { analyzeLoudnessLufs } from "@/lib/loudness";
import { extractTrackMetadata } from "@/lib/metadata";
import { enqueueRecognition } from "@/lib/recognize-queue";
import { remuxOpusToMp4 } from "@/lib/remux";
import { deleteObject, uploadObject } from "@/lib/s3";
import {
  makeThumbnail,
  THUMBNAIL_CONTENT_TYPE,
  thumbnailS3Key,
} from "@/lib/thumbnail";

// Matches proxyClientMaxBodySize in next.config.ts: the proxy truncates bodies
// past this, so routes reject above it for a clean error instead of a corrupt
// upload.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wav",
  "webm",
]);

export type IngestResult =
  | { status: "created"; track: Track }
  | { status: "duplicate"; message: string };

/**
 * Caller-supplied metadata that wins over whatever is embedded in the file.
 * The extension importer sends these: title/artist/album come from the source
 * (the YouTube video, or the Spotify/Apple track it matched), and `artUrl` is
 * that source's cover — a YouTube thumbnail (cropSquare) or Spotify/Apple
 * artwork. Mirrors the reference exporter tagging every file with title/
 * artist/album + embedded cover.
 */
export type IngestOverrides = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artUrl?: string | null;
  artCropSquare?: boolean;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The whole track-ingest pipeline, shared by the session-auth upload route
 * (POST /api/tracks) and the extension-import route: dedupe on content hash,
 * metadata/loudness/re-mux, S3 upload (audio + art + thumbnail), row insert,
 * and the background CLAP/recognition enqueues. Callers have already validated
 * type and size; they map the result to their HTTP responses.
 *
 * `overrides` (extension importer) take precedence over file-embedded tags and
 * supply a cover-art URL to fetch when the file carries no embedded art.
 */
export async function ingestTrack({
  userId,
  buffer,
  filename,
  mimeType,
  overrides,
}: {
  userId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  overrides?: IngestOverrides;
}): Promise<IngestResult> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const [duplicate] = await db
    .select({ title: tracks.title })
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), eq(tracks.contentHash, contentHash)));
  if (duplicate) {
    return {
      status: "duplicate",
      message: `Already in your library as "${duplicate.title}"`,
    };
  }

  // These three are independent — run them concurrently so the I/O-bound lrclib
  // lookup inside metadata extraction overlaps the CPU-bound ffmpeg work instead
  // of running in series. Loudness is best-effort (null on any failure, like
  // art/lyrics); the re-mux returns null for anything that isn't Opus or fails.
  // The CLAP embedding used to run here too, but it's the slowest step, so it's
  // deferred to a background queue (enqueueEmbedding, after the row exists).
  const [meta, loudnessLufs, remuxed] = await Promise.all([
    extractTrackMetadata(buffer, mimeType, filename),
    analyzeLoudnessLufs(buffer, ext),
    // iOS Safari can't play Opus-in-Ogg; losslessly re-mux Opus to MP4.
    remuxOpusToMp4(buffer, ext, mimeType),
  ]);

  // Caller overrides (extension importer) win over the file's embedded tags;
  // fall back to what the file carried. title keeps ingest's non-empty invariant.
  const title = clean(overrides?.title) ?? meta.title;
  const artist = clean(overrides?.artist) ?? meta.artist;
  const album = clean(overrides?.album) ?? meta.album;

  // Cover art: prefer the file's embedded art; otherwise fetch the caller's art
  // URL (Spotify/Apple artwork, or a YouTube thumbnail cropped square). Both are
  // untrusted — the fetch sniffs the bytes for the stored kind. Anything still
  // missing (no embedded art, no/failed URL) is left to the background
  // recognition worker, exactly as before.
  let cover: { body: Buffer; contentType: string; ext: string } | null =
    meta.artBuffer
      ? { body: meta.artBuffer, ...imageKindFromMime(meta.artMime) }
      : null;
  if (!cover && overrides?.artUrl) {
    const fetched = await fetchCoverArt(overrides.artUrl, {
      cropSquare: overrides.artCropSquare,
    });
    if (fetched) {
      cover = {
        body: fetched.body,
        contentType: fetched.kind.contentType,
        ext: fetched.kind.ext,
      };
    }
  }

  const trackId = randomUUID();
  // Store the lossless MP4 re-mux for Opus, otherwise the original bytes. The
  // client-supplied filename is untrusted, so only allowlisted extensions reach
  // the key; the claimed MIME type is untrusted too, so we only keep it when
  // it's audio/* (anything else gets a neutral Content-Type so it can't be
  // served as active content — the offline service worker replays this from a
  // same-origin cache).
  const originalExt = AUDIO_EXTENSIONS.has(ext) ? ext : "bin";
  const originalType = mimeType.startsWith("audio/") ? mimeType : null;
  const audioBody = remuxed ? remuxed.body : buffer;
  const audioExt = remuxed ? remuxed.ext : originalExt;
  const storedType = remuxed ? remuxed.contentType : originalType;
  const s3Key = `audio/${userId}/${trackId}.${audioExt}`;

  // Upload audio and cover art together. Art is best-effort and must never fail
  // the track — swallow its errors and drop the key so the row isn't orphaned.
  let artS3Key: string | null = null;
  let artThumbS3Key: string | null = null;
  const uploads: Promise<unknown>[] = [
    uploadObject(s3Key, audioBody, storedType ?? undefined),
  ];
  if (cover) {
    artS3Key = `art/${userId}/${trackId}.${cover.ext}`;
    uploads.push(
      uploadObject(artS3Key, cover.body, cover.contentType).catch((err) => {
        artS3Key = null; // leave the track artless rather than orphan a row
        log.warn(
          "upload",
          `art upload failed ${trackId}`,
          err instanceof Error ? err.message : String(err)
        );
      })
    );
    // Best-effort downscaled thumbnail for <=64px list/queue/mini-bar rows;
    // failure just means those rows fall back to the full art via the /art route.
    const thumbKey = thumbnailS3Key(userId, trackId);
    uploads.push(
      makeThumbnail(cover.body, cover.ext)
        .then((thumb) =>
          thumb
            ? uploadObject(thumbKey, thumb, THUMBNAIL_CONTENT_TYPE).then(() => {
                artThumbS3Key = thumbKey;
              })
            : undefined
        )
        .catch((err) => {
          artThumbS3Key = null;
          log.warn(
            "upload",
            `thumb upload failed ${trackId}`,
            err instanceof Error ? err.message : String(err)
          );
        })
    );
  }
  await Promise.all(uploads);
  // Don't reference a thumb for an artless track (if the full-art upload failed).
  if (!artS3Key) artThumbS3Key = null;

  try {
    const [track] = await db
      .insert(tracks)
      .values({
        id: trackId,
        ownerId: userId,
        title,
        artist,
        album,
        durationSec: meta.durationSec,
        loudnessLufs,
        s3Key,
        artS3Key,
        artThumbS3Key,
        mimeType: storedType,
        fileSize: audioBody.length,
        contentHash,
        lyrics: meta.lyrics,
        lyricsSource: meta.lyricsSource,
      })
      .returning();
    // Compute the CLAP embedding in the background (the slowest upload step),
    // now that the row + S3 object exist. Best-effort: a missing row just means
    // this track won't seed/appear in "play similar" until the worker (or the
    // backfill script) fills it in — it must never fail or delay the upload.
    enqueueEmbedding({ trackId, s3Key, ext: audioExt });
    // Fill any MISSING artist/album/cover-art in the background via acoustic
    // fingerprinting (AcoustID) + Cover Art Archive, with the iTunes art lookup
    // as the fallback. Never overwrites existing data; the title is left alone.
    // Overrides that filled these (extension importer) suppress the lookup.
    if (!artist || !album || !artS3Key) {
      enqueueRecognition({ trackId, s3Key, ext: audioExt });
    }
    return { status: "created", track };
  } catch (err) {
    // Concurrent upload of the same file slipped past the dedupe check.
    if (isUniqueViolation(err)) {
      try {
        await deleteObject(s3Key);
        if (artS3Key) await deleteObject(artS3Key);
        if (artThumbS3Key) await deleteObject(artThumbS3Key);
      } catch {
        // Orphaned object is harmless.
      }
      return { status: "duplicate", message: "Already in your library" };
    }
    throw err;
  }
}
