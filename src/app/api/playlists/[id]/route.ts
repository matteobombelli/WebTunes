import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  getAccessiblePlaylist,
  getOwnPlaylist,
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

  const trackDTOs = await getPlaylistTracks(id, user.id);
  const ownerName =
    playlist.ownerId === user.id ? null : await getDisplayName(playlist.ownerId);
  return NextResponse.json({
    ...(await toPlaylistDTO(playlist, trackDTOs.length, ownerName)),
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
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid playlist update" }, { status: 400 });
  }

  const { name, isPrivate } = parsed.data;
  const [updated] = await db
    .update(playlists)
    .set({
      ...(name !== undefined && { name }),
      ...(isPrivate !== undefined && { isPrivate }),
      updatedAt: new Date(),
    })
    .where(eq(playlists.id, id))
    .returning();
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

  if (playlist.coverS3Key) {
    try {
      await deleteObject(playlist.coverS3Key);
    } catch {
      // Orphaned cover object is harmless.
    }
  }
  await db.delete(playlists).where(eq(playlists.id, id));
  return new NextResponse(null, { status: 204 });
}
