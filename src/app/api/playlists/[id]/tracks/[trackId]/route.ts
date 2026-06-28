import { and, eq, gt, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { playlists, playlistTracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getOwnPlaylist } from "@/lib/playlists";
import { isUuid } from "@/lib/validate";

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
  // Removing a non-member is already a no-op 204; a non-UUID id is the same.
  if (!isUuid(trackId)) return new NextResponse(null, { status: 204 });

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
      // Removing a track changes the playlist's contents, so bump updatedAt
      // (list ordering + DTO), like add/reorder/rename/cover do. Guarded on
      // `removed` so a no-op delete (non-member) doesn't bump.
      await tx
        .update(playlists)
        .set({ updatedAt: new Date() })
        .where(eq(playlists.id, id));
    }
  });
  return new NextResponse(null, { status: 204 });
}
