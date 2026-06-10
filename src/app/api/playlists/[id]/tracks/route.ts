import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, playlistTracks, tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { getOwnPlaylist } from "@/lib/playlists";

type Params = { params: Promise<{ id: string }> };

const addSchema = z.object({ trackId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "trackId is required" }, { status: 400 });
  }

  const [track] = await db
    .select({ id: tracks.id, ownerId: tracks.ownerId })
    .from(tracks)
    .where(eq(tracks.id, parsed.data.trackId));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (!(await canAccessTrack(user.id, track.ownerId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [existing] = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(
      and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, track.id))
    );
  if (existing) {
    return NextResponse.json({ error: "Already in playlist" }, { status: 409 });
  }

  await db.insert(playlistTracks).values({
    playlistId: id,
    trackId: track.id,
    position: sql`coalesce((select max(${playlistTracks.position}) + 1
      from ${playlistTracks} where ${playlistTracks.playlistId} = ${id}), 0)`,
  });
  await db
    .update(playlists)
    .set({ updatedAt: new Date() })
    .where(eq(playlists.id, id));
  return new NextResponse(null, { status: 204 });
}

const reorderSchema = z.object({ trackIds: z.array(z.string().uuid()).min(1) });

export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = reorderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "trackIds array is required" }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    for (const [position, trackId] of parsed.data.trackIds.entries()) {
      await tx
        .update(playlistTracks)
        .set({ position })
        .where(
          and(
            eq(playlistTracks.playlistId, id),
            eq(playlistTracks.trackId, trackId)
          )
        );
    }
  });
  return new NextResponse(null, { status: 204 });
}
