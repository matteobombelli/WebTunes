import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { deleteObject, getPresignedGetUrl, uploadObject } from "@/lib/s3";
import { toTrackDTO } from "@/lib/tracks";
import { isUuid } from "@/lib/validate";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

// Stable per-track cover-art URL (mirrors the stream route): the client keys
// on this URL while the presigned redirect target rotates per request.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const [track] = await db
    .select({
      id: tracks.id,
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
      artS3Key: tracks.artS3Key,
    })
    .from(tracks)
    .where(eq(tracks.id, id));
  if (!track || !track.artS3Key) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { url } = await getPresignedGetUrl(track.artS3Key);
  return NextResponse.redirect(url, 302);
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

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.type.startsWith("image/") && !IMAGE_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: "Art must be an image" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Image exceeds the 5 MB limit" },
      { status: 400 }
    );
  }

  // Normalize the extension (allowlisted — the client filename is untrusted);
  // replace the old object when the key differs so we don't leak it.
  const normExt = ext === "jpeg" ? "jpg" : ext;
  const s3Key = `art/${user.id}/${id}.${
    IMAGE_EXTENSIONS.has(ext) ? normExt : "img"
  }`;
  if (track.artS3Key && track.artS3Key !== s3Key) {
    try {
      await deleteObject(track.artS3Key);
    } catch {
      // Orphaned art object is harmless.
    }
  }
  await uploadObject(s3Key, Buffer.from(await file.arrayBuffer()), file.type);

  const [updated] = await db
    .update(tracks)
    .set({ artS3Key: s3Key })
    .where(eq(tracks.id, id))
    .returning();
  return NextResponse.json(toTrackDTO(updated));
}
