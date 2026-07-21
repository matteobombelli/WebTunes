import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { imageKindFromUpload, validateImageUpload } from "@/lib/image-upload";
import { deleteObject, getPresignedGetUrl, uploadObject } from "@/lib/s3";
import {
  makeThumbnail,
  THUMBNAIL_CONTENT_TYPE,
  thumbnailS3Key,
} from "@/lib/thumbnail";
import { toTrackDTO } from "@/lib/tracks";
import { isUuid } from "@/lib/validate";

// Stable per-track cover-art URL (mirrors the stream route): the client keys
// on this URL while the presigned redirect target rotates per request.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  // The track row doesn't depend on the session, so fetch both concurrently -
  // list views fan out many /art requests, each saving a serial DB hop.
  const [user, [track]] = await Promise.all([
    requireUser(),
    db
      .select({
        id: tracks.id,
        ownerId: tracks.ownerId,
        isPrivate: tracks.isPrivate,
        suggestedImportId: tracks.suggestedImportId,
        artS3Key: tracks.artS3Key,
        artThumbS3Key: tracks.artThumbS3Key,
      })
      .from(tracks)
      .where(eq(tracks.id, id)),
  ]);
  if (!user) return unauthorized();
  if (!track || !track.artS3Key) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const canPreview = track.suggestedImportId && track.ownerId === user.id;
  if (!canPreview && !(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // `?v=thumb` serves the downscaled thumbnail when one exists, else falls back
  // to the full art (so pre-feature rows and failed thumbs still render).
  const key =
    req.nextUrl.searchParams.get("v") === "thumb" && track.artThumbS3Key
      ? track.artThumbS3Key
      : track.artS3Key;
  const { url } = await getPresignedGetUrl(key);
  // Cache the redirect per-browser, well under the 1h presigned-URL TTL, so a
  // list's thumbnails reuse across scroll/navigation without re-hitting the
  // server (session lookup + DB + access check + presign) on every render. The
  // stable /art path is kept for the SW's offline art cache; this only affects
  // online browser caching, and `private` keeps it scoped to this user.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=3000");
  return res;
}

// Upload/replace a track's cover art (owner only). Mirrors the playlist-cover
// upload; the stored key reuses the same `art/{owner}/{trackId}.ext` scheme as
// art extracted on upload, so TrackArt's stable URL keeps working.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (track.ownerId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (track.suggestedImportId) {
    return NextResponse.json(
      { error: "Accept this suggestion before editing it" },
      { status: 409 }
    );
  }

  // A truncated/garbage multipart body makes formData() reject - 400, not 500.
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 });
  }
  const upload = validateImageUpload(form.get("file"), "Art");
  if (!upload.ok) {
    return NextResponse.json({ error: upload.error }, { status: 400 });
  }
  const { file, ext } = upload;

  // Resolve the key extension and stored Content-Type from a server-side
  // allowlist - never the untrusted filename/MIME.
  const kind = imageKindFromUpload(ext, file.type);
  const s3Key = `art/${user.id}/${id}.${kind.ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await uploadObject(s3Key, bytes, kind.contentType);

  // Regenerate the thumbnail from the new art. The thumb key is deterministic,
  // so a success overwrites the old one; on failure clear it so the row never
  // points at a thumbnail of the previous cover.
  const thumbKey = thumbnailS3Key(user.id, id);
  let artThumbS3Key: string | null = null;
  const thumb = await makeThumbnail(bytes, kind.ext).catch(() => null);
  if (thumb) {
    try {
      await uploadObject(thumbKey, thumb, THUMBNAIL_CONTENT_TYPE);
      artThumbS3Key = thumbKey;
    } catch {
      artThumbS3Key = null;
    }
  }

  const [updated] = await db
    .update(tracks)
    .set({ artS3Key: s3Key, artThumbS3Key })
    .where(eq(tracks.id, id))
    .returning();
  if (!updated) {
    // Track deleted between the ownership check and the update; the fresh
    // objects are orphans the reconcile script sweeps.
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  // Only after the row points at the new objects, drop replaced ones (leak
  // beats dangling: deleting first would break art if the upload then failed).
  if (track.artS3Key && track.artS3Key !== s3Key) {
    await deleteObject(track.artS3Key).catch(() => {});
  }
  if (track.artThumbS3Key && track.artThumbS3Key !== artThumbS3Key) {
    await deleteObject(track.artThumbS3Key).catch(() => {});
  }
  return NextResponse.json(toTrackDTO(updated));
}
