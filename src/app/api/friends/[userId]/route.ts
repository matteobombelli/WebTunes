import { and, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { friendships } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";

/** Unfriend: removes an accepted friendship in either direction. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { userId } = await params;
  const [deleted] = await db
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
  if (!deleted) {
    return NextResponse.json({ error: "Not friends" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
