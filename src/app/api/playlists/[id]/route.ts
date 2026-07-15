import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  getAccessiblePlaylist,
  getEditablePlaylist,
  getOwnPlaylist,
  getPlaylistRole,
  getPlaylistTracks,
  toPlaylistDTO,
} from "@/lib/playlists";
import { deleteObject } from "@/lib/s3";
import { getDisplayName } from "@/lib/users";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getAccessiblePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const isOwner = playlist.ownerId === user.id;
  const [trackDTOs, ownerName, role] = await Promise.all([
    getPlaylistTracks(id, user.id),
    isOwner ? Promise.resolve(null) : getDisplayName(playlist.ownerId),
    getPlaylistRole(id, user.id),
  ]);
  return NextResponse.json({
    ...(await toPlaylistDTO(playlist, trackDTOs.length, ownerName, role)),
    tracks: trackDTOs,
  });
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isPrivate !== undefined, {
    message: "Nothing to update",
  });

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  // Editors (owner or collaborator) may rename; toggling privacy is owner-only.
  const playlist = await getEditablePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid playlist update" }, { status: 400 });
  }

  const { name, isPrivate } = parsed.data;
  if (isPrivate !== undefined && playlist.ownerId !== user.id) {
    return NextResponse.json(
      { error: "Only the owner can change privacy" },
      { status: 403 }
    );
  }
  const [updated] = await db
    .update(playlists)
    .set({
      ...(name !== undefined && { name }),
      ...(isPrivate !== undefined && { isPrivate }),
      updatedAt: new Date(),
    })
    .where(eq(playlists.id, id))
    .returning();
  // Deleted between the ownership check and the update.
  if (!updated) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return NextResponse.json(await toPlaylistDTO(updated));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  await db.delete(playlists).where(eq(playlists.id, id));
  if (playlist.coverS3Key) {
    try {
      await deleteObject(playlist.coverS3Key);
    } catch {
      // Orphaned cover object is harmless.
    }
  }
  return new NextResponse(null, { status: 204 });
}
