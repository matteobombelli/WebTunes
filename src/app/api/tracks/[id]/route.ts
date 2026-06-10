import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { deleteObject } from "@/lib/s3";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (!(await canAccessTrack(user.id, track.ownerId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(track);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (track.ownerId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await deleteObject(track.s3Key);
  } catch {
    // Orphaned object beats a track row pointing at deleted audio.
  }
  await db.delete(tracks).where(eq(tracks.id, id));
  return new NextResponse(null, { status: 204 });
}
