import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, isUniqueViolation } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { imageKindFromMime } from "@/lib/image-upload";
import { extractTrackMetadata } from "@/lib/metadata";
import { deleteObject, uploadObject } from "@/lib/s3";
import { listAccessibleTracks, listOwnTracks, toTrackDTO } from "@/lib/tracks";
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

  // scope=all additionally includes friends' non-private tracks.
  if (req.nextUrl.searchParams.get("scope") === "all") {
    const { hideFriendDuplicates } = await getUserSettings(user.id);
    return NextResponse.json(
      await listAccessibleTracks(user.id, hideFriendDuplicates)
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

  const meta = await extractTrackMetadata(buffer, file.type, file.name);

  const trackId = randomUUID();
  // The client-supplied filename is untrusted; only allowlisted extensions
  // make it into the S3 key.
  const s3Key = `audio/${user.id}/${trackId}.${
    AUDIO_EXTENSIONS.has(ext) ? ext : "bin"
  }`;
  // file.type is browser-supplied and untrusted; only store it when it's an
  // audio/* type. Anything else (e.g. a crafted text/html) gets a neutral
  // Content-Type so it can never be served as active content — the offline
  // service worker replays this from a same-origin cache.
  const audioType = file.type.startsWith("audio/") ? file.type : null;
  await uploadObject(s3Key, buffer, audioType ?? undefined);

  // Cover art is best-effort: a failed art upload must not fail the track.
  let artS3Key: string | null = null;
  if (meta.artBuffer) {
    try {
      const art = imageKindFromMime(meta.artMime);
      artS3Key = `art/${user.id}/${trackId}.${art.ext}`;
      await uploadObject(artS3Key, meta.artBuffer, art.contentType);
    } catch {
      artS3Key = null; // leave the track artless rather than orphan a row
    }
  }

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
        s3Key,
        artS3Key,
        mimeType: audioType,
        fileSize: file.size,
        contentHash,
        lyrics: meta.lyrics,
        lyricsSource: meta.lyricsSource,
      })
      .returning();
    return NextResponse.json(toTrackDTO(track), { status: 201 });
  } catch (err) {
    // Concurrent upload of the same file slipped past the dedupe check.
    if (isUniqueViolation(err)) {
      try {
        await deleteObject(s3Key);
        if (artS3Key) await deleteObject(artS3Key);
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
