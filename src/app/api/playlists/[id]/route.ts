import { asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, playlistTracks, tracks, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getOwnPlaylist, toPlaylistDTO } from "@/lib/playlists";
import { deleteObject } from "@/lib/s3";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const rows = await db
    .select({ track: tracks, ownerName: users.name })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(eq(playlistTracks.playlistId, id))
    .orderBy(asc(playlistTracks.position));

  return NextResponse.json({
    ...(await toPlaylistDTO(playlist, rows.length)),
    tracks: rows.map((r) => ({
      ...r.track,
      createdAt: r.track.createdAt.toISOString(),
      ownerName: r.track.ownerId === user.id ? null : r.ownerName,
    })),
  });
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(100) });

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
    return NextResponse.json({ error: "Playlist name is required" }, { status: 400 });
  }

  const [updated] = await db
    .update(playlists)
    .set({ name: parsed.data.name, updatedAt: new Date() })
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
