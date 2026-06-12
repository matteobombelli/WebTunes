import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getOwnPlaylist, toPlaylistDTO } from "@/lib/playlists";
import { deleteObject, uploadObject } from "@/lib/s3";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.type.startsWith("image/") && !IMAGE_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: "Cover must be an image" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Image exceeds the 5 MB limit" }, { status: 400 });
  }

  // Key includes the extension (allowlisted — the client filename is
  // untrusted), so replace the old object if it differs.
  const s3Key = `covers/${user.id}/${id}.${
    IMAGE_EXTENSIONS.has(ext) ? ext : "img"
  }`;
  if (playlist.coverS3Key && playlist.coverS3Key !== s3Key) {
    try {
      await deleteObject(playlist.coverS3Key);
    } catch {
      // Orphaned cover object is harmless.
    }
  }
  await uploadObject(s3Key, Buffer.from(await file.arrayBuffer()), file.type);

  const [updated] = await db
    .update(playlists)
    .set({ coverS3Key: s3Key, updatedAt: new Date() })
    .where(eq(playlists.id, id))
    .returning();
  return NextResponse.json(await toPlaylistDTO(updated));
}
