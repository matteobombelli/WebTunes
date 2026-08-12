import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, isUniqueViolation } from "@/db";
import {
  suggestedImports,
  trackIdentities,
  tracks,
  type Track,
} from "@/db/schema";
import { fetchCoverArt } from "@/lib/art-fetch";
import { enqueueEmbedding } from "@/lib/clap-queue";
import { imageKindFromMime } from "@/lib/image-upload";
import { log } from "@/lib/log";
import { analyzeLoudnessLufs } from "@/lib/loudness";
import { probeDurationSec } from "@/lib/ffprobe";
import { cleanTag, extractTrackMetadata } from "@/lib/metadata";
import { enqueueRecognition } from "@/lib/recognize-queue";
import { remuxOpusToMp4 } from "@/lib/remux";
import { deleteObject, uploadObject } from "@/lib/s3";
import {
  makeThumbnail,
  THUMBNAIL_CONTENT_TYPE,
  thumbnailS3Key,
} from "@/lib/thumbnail";

// The user-facing upload limit. API routes are excluded from Proxy so Next's
// much smaller proxyClientMaxBodySize does not truncate track uploads.
export const MAX_FILE_BYTES = 90 * 1024 * 1024;

type AudioKind = { ext: string; contentType: string };

const AUDIO_KIND_BY_EXTENSION: Record<string, AudioKind> = {
  mp3: { ext: "mp3", contentType: "audio/mpeg" },
  m4a: { ext: "m4a", contentType: "audio/mp4" },
  aac: { ext: "aac", contentType: "audio/aac" },
  flac: { ext: "flac", contentType: "audio/flac" },
  ogg: { ext: "ogg", contentType: "audio/ogg" },
  opus: { ext: "opus", contentType: "audio/ogg" },
  wav: { ext: "wav", contentType: "audio/wav" },
  webm: { ext: "webm", contentType: "audio/webm" },
};

// Browsers disagree on several audio Content-Types (notably Safari's m4a and
// WAV values). Accept the common aliases, but always persist the canonical
// allowlisted value above. Unknown extensions can still be accepted when the
// browser supplies one of these recognized types.
const AUDIO_KIND_BY_MIME = new Map<string, AudioKind>([
  ["audio/mpeg", AUDIO_KIND_BY_EXTENSION.mp3],
  ["audio/mp3", AUDIO_KIND_BY_EXTENSION.mp3],
  ["audio/x-mpeg", AUDIO_KIND_BY_EXTENSION.mp3],
  ["audio/mp4", AUDIO_KIND_BY_EXTENSION.m4a],
  ["audio/m4a", AUDIO_KIND_BY_EXTENSION.m4a],
  ["audio/x-m4a", AUDIO_KIND_BY_EXTENSION.m4a],
  ["audio/aac", AUDIO_KIND_BY_EXTENSION.aac],
  ["audio/x-aac", AUDIO_KIND_BY_EXTENSION.aac],
  ["audio/flac", AUDIO_KIND_BY_EXTENSION.flac],
  ["audio/x-flac", AUDIO_KIND_BY_EXTENSION.flac],
  ["audio/ogg", AUDIO_KIND_BY_EXTENSION.ogg],
  ["application/ogg", AUDIO_KIND_BY_EXTENSION.ogg],
  ["audio/opus", AUDIO_KIND_BY_EXTENSION.opus],
  ["audio/wav", AUDIO_KIND_BY_EXTENSION.wav],
  ["audio/wave", AUDIO_KIND_BY_EXTENSION.wav],
  ["audio/x-wav", AUDIO_KIND_BY_EXTENSION.wav],
  ["audio/vnd.wave", AUDIO_KIND_BY_EXTENSION.wav],
  ["audio/webm", AUDIO_KIND_BY_EXTENSION.webm],
]);

function audioKind(filename: string, mimeType: string): AudioKind | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const byExtension = AUDIO_KIND_BY_EXTENSION[ext];
  if (byExtension) return byExtension;

  const normalizedMime = mimeType.split(";", 1)[0].trim().toLowerCase();
  return AUDIO_KIND_BY_MIME.get(normalizedMime) ?? null;
}

type IngestResult =
  | { status: "created"; track: Track }
  | { status: "duplicate"; message: string };

/**
 * Validate an uploaded audio file (shape + claimed type + size), shared by web
 * uploads and server-side import callers so their rules can't drift. Returns
 * the File, or the 400 message.
 */
export function validateAudioUpload(
  value: unknown
): { ok: true; file: File } | { ok: false; error: string } {
  if (!(value instanceof File)) return { ok: false, error: "Missing file" };
  if (value.size === 0) return { ok: false, error: "Audio file is empty" };
  if (!audioKind(value.name, value.type)) {
    const ext = value.name.split(".").pop()?.toLowerCase() ?? "";
    return { ok: false, error: `Unsupported file type: ${value.type || ext}` };
  }
  if (value.size > MAX_FILE_BYTES) {
    return { ok: false, error: "File exceeds the 90 MB limit" };
  }
  return { ok: true, file: value };
}

/**
 * Server-side import metadata that wins over whatever is embedded in the file.
 * The in-site importer supplies title/artist/album from the source (the
 * YouTube video, or the Spotify/Apple track it matched), and `artUrl` is that
 * source's cover - a YouTube thumbnail (cropSquare) or Spotify/Apple artwork.
 */
type IngestOverrides = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artUrl?: string | null;
  artCropSquare?: boolean;
};

type KnownTrackIdentity = {
  acoustidId?: string | null;
  recordingMbid: string;
  artistMbids?: string[];
  releaseGroupMbid?: string | null;
};

/**
 * The whole track-ingest pipeline, shared by browser uploads, in-site imports,
 * and Suggested Imports: dedupe on content hash, metadata/loudness/re-mux, S3
 * upload (audio + art + thumbnail), row insert, and the background CLAP/
 * recognition enqueues. Callers have already validated type and size; they map
 * the result to their HTTP responses.
 *
 * `overrides` take precedence over file-embedded tags and supply a cover-art
 * URL to fetch when the file carries no embedded art.
 */
export async function ingestTrack({
  userId,
  buffer,
  filename,
  mimeType,
  overrides,
  suggestedImportId,
  identity,
}: {
  userId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  overrides?: IngestOverrides;
  /** Internal-only staging link used by Suggested Imports. */
  suggestedImportId?: string;
  /** Canonical identity already supplied by ListenBrainz/MusicBrainz. */
  identity?: KnownTrackIdentity;
}): Promise<IngestResult> {
  if (buffer.length === 0) throw new Error("Audio file is empty");
  const kind = audioKind(filename, mimeType);
  if (!kind) throw new Error(`Unsupported audio type: ${mimeType || filename}`);
  const { ext, contentType: canonicalMimeType } = kind;

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const [duplicate] = await db
    .select()
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), eq(tracks.contentHash, contentHash)));
  if (duplicate) {
    // An explicit upload/import of bytes that are currently only a staged
    // suggestion is a clear keep action. Promote that existing row instead of
    // reporting a duplicate the user cannot find in their library.
    if (duplicate.suggestedImportId && !suggestedImportId) {
      const suggestionId = duplicate.suggestedImportId;
      const promoted = await db.transaction(async (tx) => {
        const acceptedAt = new Date();
        const [row] = await tx
          .update(tracks)
          .set({
            suggestedImportId: null,
            isPrivate: false,
            createdAt: acceptedAt,
          })
          .where(
            and(
              eq(tracks.id, duplicate.id),
              eq(tracks.suggestedImportId, suggestionId)
            )
          )
          .returning();
        if (row) {
          await tx
            .update(suggestedImports)
            .set({ status: "accepted", progress: 100, updatedAt: acceptedAt })
            .where(eq(suggestedImports.id, suggestionId));
        }
        return row;
      });
      if (promoted) return { status: "created", track: promoted };
    }
    return {
      status: "duplicate",
      message: `Already in your library as "${duplicate.title}"`,
    };
  }

  // Run independent metadata/ffmpeg work concurrently. CLAP remains deferred
  // until after the row exists because it is substantially slower.
  const [meta, loudnessLufs, remuxed] = await Promise.all([
    extractTrackMetadata(buffer, canonicalMimeType, filename),
    analyzeLoudnessLufs(buffer, ext),
    // iOS Safari can't play Opus-in-Ogg; losslessly re-mux Opus to MP4.
    remuxOpusToMp4(buffer, ext, canonicalMimeType),
  ]);

  // Caller overrides win over the file's embedded tags;
  // fall back to what the file carried. title keeps ingest's non-empty
  // invariant; cleanTag also caps + NFC-normalizes the untrusted overrides.
  const title = cleanTag(overrides?.title) ?? meta.title;
  const artist = cleanTag(overrides?.artist) ?? meta.artist;
  const album = cleanTag(overrides?.album) ?? meta.album;

  // Cover art: prefer the file's embedded art; otherwise fetch the caller's art
  // URL (Spotify/Apple artwork, or a YouTube thumbnail cropped square). Both are
  // untrusted - the fetch sniffs the bytes for the stored kind. Anything still
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
  // client-supplied filename and MIME are untrusted. `audioKind` resolves them
  // through a fixed allowlist, so only canonical extensions and Content-Types
  // reach S3/DB or the same-origin offline cache.
  const audioBody = remuxed ? remuxed.body : buffer;
  const audioExt = remuxed ? remuxed.ext : ext;
  const storedType = remuxed ? remuxed.contentType : canonicalMimeType;
  const s3Key = `audio/${userId}/${trackId}.${audioExt}`;

  // Measure duration on the EXACT bytes we store (post-remux) so the listed time
  // always matches what actually plays; music-metadata measured the original
  // upload buffer, which diverges from the remuxed MP4 for Opus. Best-effort -
  // fall back to the music-metadata value when ffprobe can't measure it.
  const durationSec = (await probeDurationSec(audioBody, audioExt)) ?? meta.durationSec;

  // Upload audio and cover art together. Art is best-effort and must never fail
  // the track - swallow its errors and drop the key so the row isn't orphaned.
  let artS3Key: string | null = null;
  let artThumbS3Key: string | null = null;
  const uploads: Promise<unknown>[] = [
    uploadObject(s3Key, audioBody, storedType),
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
    const track = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tracks)
        .values({
          id: trackId,
          ownerId: userId,
          suggestedImportId,
          title,
          artist,
          album,
          durationSec,
          loudnessLufs,
          s3Key,
          artS3Key,
          artThumbS3Key,
          mimeType: storedType,
          fileSize: audioBody.length,
          contentHash,
          lyrics: meta.lyrics,
          lyricsSource: meta.lyricsSource,
          isPrivate: suggestedImportId ? true : false,
        })
        .returning();
      if (identity) {
        await tx.insert(trackIdentities).values({
          trackId,
          status: "recognized",
          acoustidId: identity.acoustidId ?? null,
          recordingMbid: identity.recordingMbid,
          artistMbids: identity.artistMbids ?? [],
          releaseGroupMbid: identity.releaseGroupMbid ?? null,
        });
      }
      return created;
    });
    // Compute the CLAP embedding in the background (the slowest upload step),
    // now that the row + S3 object exist. Best-effort: a missing row just means
    // this track won't seed/appear in "play similar" until the worker (or the
    // backfill script) fills it in - it must never fail or delay the upload.
    enqueueEmbedding({ trackId, s3Key, ext: audioExt });
    // Fill MISSING metadata/art in the background. Acoustic fingerprinting is
    // reserved for missing tags; well-tagged tracks use the fast batched
    // ListenBrainz mapper only if they later become recommendation seeds.
    if (!artist || !album || !artS3Key) {
      enqueueRecognition({
        trackId,
        s3Key,
        ext: audioExt,
        identify: !identity && (!artist || !album),
      });
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
