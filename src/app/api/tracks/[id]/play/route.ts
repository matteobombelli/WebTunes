import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { listens, tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { isUuid } from "@/lib/validate";

// Records a play: the client fires this once a track has been played to ≥30s.
// Every accessible play (owner included) is logged to `listens` — the
// timestamped, per-user signal Discover ranks "Your top 100" and "Friends"
// from. friend_play_count stays the global, owner-excluded counter behind the
// "listen count" column. The server is the access/ownership boundary, so the
// client may fire for any track it plays.
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
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Log the listen for everyone with access (owner included) — powers Discover.
  await db.insert(listens).values({ userId: user.id, trackId: id });
  // friend_play_count stays owner-excluded.
  if (track.ownerId !== user.id) {
    await db
      .update(tracks)
      .set({ friendPlayCount: sql`${tracks.friendPlayCount} + 1` })
      .where(eq(tracks.id, id));
  }
  return new NextResponse(null, { status: 204 });
}
