import { and, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { friendships } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { isUuid } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** Accept an incoming pending request (addressee only). */
export async function PATCH(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  const [updated] = await db
    .update(friendships)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(
      and(
        eq(friendships.id, id),
        eq(friendships.addresseeId, user.id),
        eq(friendships.status, "pending")
      )
    )
    .returning({ id: friendships.id });
  if (!updated) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

/** Decline (addressee) or cancel (requester) a pending request. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  const [deleted] = await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.id, id),
        eq(friendships.status, "pending"),
        or(
          eq(friendships.requesterId, user.id),
          eq(friendships.addresseeId, user.id)
        )
      )
    )
    .returning({ id: friendships.id });
  if (!deleted) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
