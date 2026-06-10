import { and, eq, gt, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { playlistTracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getOwnPlaylist } from "@/lib/playlists";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id, trackId } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(playlistTracks)
      .where(
        and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, trackId))
      )
      .returning({ position: playlistTracks.position });
    if (removed) {
      await tx
        .update(playlistTracks)
        .set({ position: sql`${playlistTracks.position} - 1` })
        .where(
          and(
            eq(playlistTracks.playlistId, id),
            gt(playlistTracks.position, removed.position)
          )
        );
    }
  });
  return new NextResponse(null, { status: 204 });
}
