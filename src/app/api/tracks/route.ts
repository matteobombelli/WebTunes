import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, isUniqueViolation } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { enqueueEmbedding } from "@/lib/clap-queue";
import { imageKindFromMime } from "@/lib/image-upload";
import { analyzeLoudnessLufs } from "@/lib/loudness";
import { extractTrackMetadata } from "@/lib/metadata";
import { findCoverArt } from "@/lib/metadata-lookup";
import { remuxOpusToMp4 } from "@/lib/remux";
import { deleteObject, uploadObject } from "@/lib/s3";
import {
  makeThumbnail,
  THUMBNAIL_CONTENT_TYPE,
  thumbnailS3Key,
} from "@/lib/thumbnail";
import {
  listAccessibleTracks,
  listFriendsTracks,
  listOwnTracks,
  toTrackDTO,
} from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";

// Matches proxyClientMaxBodySize in next.config.ts: the proxy truncates bodies
// past this, so reject here for a clean error instead of a corrupt upload.
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wav",
  "webm",
]);

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  // scope=all adds friends' non-private tracks to the viewer's own; scope=friends
  // returns only friends' (own excluded) so that view doesn't over-fetch.
  const scope = req.nextUrl.searchParams.get("scope");
  if (scope === "all" || scope === "friends") {
    const { hideFriendDuplicates } = await getUserSettings(user.id);
    return NextResponse.json(
      scope === "friends"
        ? await listFriendsTracks(user.id, hideFriendDuplicates)
        : await listAccessibleTracks(user.id, hideFriendDuplicates)
    );
  }
  return NextResponse.json(await listOwnTracks(user.id));
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isAudio =
    file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext);
  if (!isAudio) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || ext}` },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 100 MB limit" },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const [duplicate] = await db
    .select({ title: tracks.title })
    .from(tracks)
    .where(
      and(eq(tracks.ownerId, user.id), eq(tracks.contentHash, contentHash))
    );
  if (duplicate) {
    return NextResponse.json(
      { error: `Already in your library as "${duplicate.title}"` },
      { status: 409 }
    );
  }

  // These three are independent — run them concurrently so the I/O-bound lrclib
  // lookup inside metadata extraction overlaps the CPU-bound ffmpeg work instead
  // of running in series. Loudness is best-effort (null on any failure, like
  // art/lyrics); the re-mux returns null for anything that isn't Opus or fails.
  // The CLAP embedding used to run here too, but it's the slowest step, so it's
  // deferred to a background queue (enqueueEmbedding, after the row exists).
  const [meta, loudnessLufs, remuxed] = await Promise.all([
    extractTrackMetadata(buffer, file.type, file.name),
    analyzeLoudnessLufs(buffer, ext),
    // iOS Safari can't play Opus-in-Ogg; losslessly re-mux Opus to MP4.
    remuxOpusToMp4(buffer, ext, file.type),
  ]);

  // Best-effort online cover art for uploads that have an artist but no embedded
  // art — like loudness/CLAP/lyrics, it never delays or fails a normal, fully-
  // arted upload (only artless files reach a network call) and needs no API key.
  let cover: { body: Buffer; contentType: string; ext: string } | null =
    meta.artBuffer
      ? { body: meta.artBuffer, ...imageKindFromMime(meta.artMime) }
      : null;
  if (!cover && meta.artist) {
    try {
      const art = await findCoverArt({
        artist: meta.artist,
        album: meta.album,
        title: meta.title,
      });
      if (art)
        cover = { body: art.body, contentType: art.kind.contentType, ext: art.kind.ext };
    } catch {
      // best-effort; never block the upload
    }
  }

  const trackId = randomUUID();
  // Store the lossless MP4 re-mux for Opus, otherwise the original bytes. The
  // client-supplied filename is untrusted, so only allowlisted extensions reach
  // the key; file.type is untrusted too, so we only keep it when it's audio/*
  // (anything else gets a neutral Content-Type so it can't be served as active
  // content — the offline service worker replays this from a same-origin cache).
  const originalExt = AUDIO_EXTENSIONS.has(ext) ? ext : "bin";
  const originalType = file.type.startsWith("audio/") ? file.type : null;
  const audioBody = remuxed ? remuxed.body : buffer;
  const audioExt = remuxed ? remuxed.ext : originalExt;
  const storedType = remuxed ? remuxed.contentType : originalType;
  const s3Key = `audio/${user.id}/${trackId}.${audioExt}`;

  // Upload audio and cover art together. Art is best-effort and must never fail
  // the track — swallow its errors and drop the key so the row isn't orphaned.
  let artS3Key: string | null = null;
  let artThumbS3Key: string | null = null;
  const uploads: Promise<unknown>[] = [
    uploadObject(s3Key, audioBody, storedType ?? undefined),
  ];
  if (cover) {
    artS3Key = `art/${user.id}/${trackId}.${cover.ext}`;
    uploads.push(
      uploadObject(artS3Key, cover.body, cover.contentType).catch(() => {
        artS3Key = null; // leave the track artless rather than orphan a row
      })
    );
    // Best-effort downscaled thumbnail for <=64px list/queue/mini-bar rows;
    // failure just means those rows fall back to the full art via the /art route.
    const thumbKey = thumbnailS3Key(user.id, trackId);
    uploads.push(
      makeThumbnail(cover.body, cover.ext)
        .then((thumb) =>
          thumb
            ? uploadObject(thumbKey, thumb, THUMBNAIL_CONTENT_TYPE).then(() => {
                artThumbS3Key = thumbKey;
              })
            : undefined
        )
        .catch(() => {
          artThumbS3Key = null;
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
        ownerId: user.id,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
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
    return NextResponse.json(toTrackDTO(track), { status: 201 });
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
      return NextResponse.json(
        { error: "Already in your library" },
        { status: 409 }
      );
    }
    throw err;
  }
}
