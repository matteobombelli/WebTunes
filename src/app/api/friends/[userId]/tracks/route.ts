import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { areFriends } from "@/lib/friends";

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
  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.ownerId, userId))
    .orderBy(desc(tracks.createdAt));

  return NextResponse.json(
    rows.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      ownerName: owner?.name ?? null,
    }))
  );
}
