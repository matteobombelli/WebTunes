import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, playlistTracks, tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { getOwnPlaylist } from "@/lib/playlists";

type Params = { params: Promise<{ id: string }> };

const addSchema = z.union([
  z.object({ trackId: z.string().uuid() }),
  z.object({ trackIds: z.array(z.string().uuid()).min(1).max(500) }),
]);

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
    return NextResponse.json(
      { error: "trackId or trackIds is required" },
      { status: 400 }
    );
  }
  const requestedIds =
    "trackId" in parsed.data ? [parsed.data.trackId] : parsed.data.trackIds;

  const candidates = await db
    .select({
      id: tracks.id,
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
    })
    .from(tracks)
    .where(inArray(tracks.id, requestedIds));
  if (candidates.length !== requestedIds.length) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  for (const track of candidates) {
    if (!(await canAccessTrack(user.id, track))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const existing = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(
      and(
        eq(playlistTracks.playlistId, id),
        inArray(playlistTracks.trackId, requestedIds)
      )
    );
  const existingIds = new Set(existing.map((e) => e.trackId));
  // Preserve request order; silently skip tracks already in the playlist.
  const toAdd = requestedIds.filter((tid) => !existingIds.has(tid));
  if (toAdd.length === 0) {
    return NextResponse.json({ error: "Already in playlist" }, { status: 409 });
  }

  await db.transaction(async (tx) => {
    const [{ base }] = await tx
      .select({
        base: sql<number>`coalesce(max(${playlistTracks.position}) + 1, 0)::int`,
      })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, id));
    await tx.insert(playlistTracks).values(
      toAdd.map((trackId, i) => ({
        playlistId: id,
        trackId,
        position: base + i,
      }))
    );
    await tx
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, id));
  });
  return NextResponse.json({ added: toAdd.length }, { status: 200 });
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
    await tx
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, id));
  });
  return new NextResponse(null, { status: 204 });
}
