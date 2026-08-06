import { and, eq, inArray, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { friendships, playlistCollaborators, playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { isUuid } from "@/lib/validate";

/** Unfriend: removes an accepted friendship in either direction. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { userId } = await params;
  if (!isUuid(userId)) {
    return NextResponse.json({ error: "Not friends" }, { status: 404 });
  }
  const deleted = await db.transaction(async (tx) => {
    const [friendship] = await tx
      .delete(friendships)
      .where(
        and(
          eq(friendships.status, "accepted"),
          or(
            and(
              eq(friendships.requesterId, user.id),
              eq(friendships.addresseeId, userId)
            ),
            and(
              eq(friendships.requesterId, userId),
              eq(friendships.addresseeId, user.id)
            )
          )
        )
      )
      .returning({ id: friendships.id });
    if (!friendship) return false;

    const ownPlaylistIds = tx
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.ownerId, user.id));
    const formerFriendPlaylistIds = tx
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.ownerId, userId));
    await tx
      .delete(playlistCollaborators)
      .where(
        or(
          and(
            eq(playlistCollaborators.userId, userId),
            inArray(playlistCollaborators.playlistId, ownPlaylistIds)
          ),
          and(
            eq(playlistCollaborators.userId, user.id),
            inArray(
              playlistCollaborators.playlistId,
              formerFriendPlaylistIds
            )
          )
        )
      );
    return true;
  });
  if (!deleted) {
    return NextResponse.json({ error: "Not friends" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
