import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { imageKindFromUpload, validateImageUpload } from "@/lib/image-upload";
import {
  getAccessiblePlaylist,
  getEditablePlaylist,
  toPlaylistDTO,
} from "@/lib/playlists";
import { deleteObject, getPresignedGetUrl, uploadObject } from "@/lib/s3";

// Stable per-playlist cover URL (mirrors the track /art route): the client keys
// on this URL while the presigned redirect target rotates per request, so a
// cover can't go stale mid-session the way an embedded presigned URL would.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  // getAccessiblePlaylist allows a friend's shared playlist and guards bad
  // UUIDs (→ null); private/foreign/missing all collapse to 404.
  const playlist = await getAccessiblePlaylist(id, user.id);
  if (!playlist || !playlist.coverS3Key) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const { url } = await getPresignedGetUrl(playlist.coverS3Key);
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=3000");
  return res;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getEditablePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  // A truncated/garbage multipart body makes formData() reject — 400, not 500.
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 });
  }
  const upload = validateImageUpload(form.get("file"), "Cover");
  if (!upload.ok) {
    return NextResponse.json({ error: upload.error }, { status: 400 });
  }
  const { file, ext } = upload;

  // Key extension and stored Content-Type come from a server-side allowlist —
  // never the untrusted filename/MIME.
  const kind = imageKindFromUpload(ext, file.type);
  const s3Key = `covers/${user.id}/${id}.${kind.ext}`;
  await uploadObject(s3Key, Buffer.from(await file.arrayBuffer()), kind.contentType);

  const [updated] = await db
    .update(playlists)
    .set({ coverS3Key: s3Key, updatedAt: new Date() })
    .where(eq(playlists.id, id))
    .returning();
  if (!updated) {
    // Playlist deleted between the ownership check and the update; the fresh
    // object is an orphan the reconcile script sweeps.
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  // Only after the row points at the new object, drop the replaced one (leak
  // beats dangling: deleting first would break the cover if the upload failed).
  if (playlist.coverS3Key && playlist.coverS3Key !== s3Key) {
    await deleteObject(playlist.coverS3Key).catch(() => {});
  }
  return NextResponse.json(await toPlaylistDTO(updated));
}
