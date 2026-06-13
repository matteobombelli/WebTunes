import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, isUniqueViolation } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { extractTrackMetadata } from "@/lib/metadata";
import { deleteObject, uploadObject } from "@/lib/s3";
import { listAccessibleTracks, listOwnTracks, toTrackDTO } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";

const MAX_FILE_BYTES = 200 * 1024 * 1024;

// An embedded picture's mime type is attacker-controlled (it comes from the
// uploaded file's tag), so derive both the S3 key extension and the stored
// Content-Type from a fixed allowlist rather than echoing the tag verbatim —
// otherwise a crafted file could set e.g. text/html on the served object.
function imageKind(mime: string | null): { ext: string; type: string } {
  switch (mime) {
    case "image/png":
      return { ext: "png", type: "image/png" };
    case "image/webp":
      return { ext: "webp", type: "image/webp" };
    case "image/gif":
      return { ext: "gif", type: "image/gif" };
    default:
      return { ext: "jpg", type: "image/jpeg" }; // jpeg: the common case
  }
}
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
      { error: "File exceeds the 200 MB limit" },
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
  await uploadObject(s3Key, buffer, file.type || undefined);

  // Cover art is best-effort: a failed art upload must not fail the track.
  let artS3Key: string | null = null;
  if (meta.artBuffer) {
    try {
      const art = imageKind(meta.artMime);
      artS3Key = `art/${user.id}/${trackId}.${art.ext}`;
      await uploadObject(artS3Key, meta.artBuffer, art.type);
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
        mimeType: file.type || null,
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
