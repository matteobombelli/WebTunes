import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { areFriends } from "@/lib/friends";
import { listFriendTracks } from "@/lib/tracks";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { userId } = await params;
  if (!(await areFriends(user.id, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [owner] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return NextResponse.json(await listFriendTracks(userId, owner?.name ?? null));
}
