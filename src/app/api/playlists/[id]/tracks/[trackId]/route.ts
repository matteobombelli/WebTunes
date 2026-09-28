import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { removePlaylistTracks } from "@/lib/playlists";

export async function DELETE(
  _req: NextRequest,
  { params }: RouteContext<"/api/playlists/[id]/tracks/[trackId]">
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id, trackId } = await params;
  // Removing a non-member (or a non-UUID id) is a no-op 204.
  const result = await removePlaylistTracks(id, user.id, [trackId]);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
