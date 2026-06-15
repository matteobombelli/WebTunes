import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { isUuid } from "@/lib/validate";

// Records a "friend play": the client fires this once a track has been played
// to ≥30s. Plays by the track's owner don't count; the server is the
// correctness boundary, so the client may fire for any track it plays.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const [track] = await db
    .select({ ownerId: tracks.ownerId, isPrivate: tracks.isPrivate })
    .from(tracks)
    .where(eq(tracks.id, id));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  // Owner plays don't count toward the friend play count.
  if (track.ownerId === user.id) {
    return new NextResponse(null, { status: 204 });
  }
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db
    .update(tracks)
    .set({ friendPlayCount: sql`${tracks.friendPlayCount} + 1` })
    .where(eq(tracks.id, id));
  return new NextResponse(null, { status: 204 });
}
