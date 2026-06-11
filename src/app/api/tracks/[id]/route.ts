import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { deleteObject } from "@/lib/s3";
import { toTrackDTO } from "@/lib/tracks";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().max(200).nullable(),
    album: z.string().trim().max(200).nullable(),
    isPrivate: z.boolean(),
  })
  .partial();

export async function PATCH(req: NextRequest, { params }: Params) {
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

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Empty strings clear artist/album to null.
  const updates = { ...parsed.data };
  if (updates.artist === "") updates.artist = null;
  if (updates.album === "") updates.album = null;

  const [updated] = await db
    .update(tracks)
    .set(updates)
    .where(eq(tracks.id, id))
    .returning();
  return NextResponse.json(toTrackDTO(updated));
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(toTrackDTO(track));
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

  await db.delete(tracks).where(eq(tracks.id, id));
  try {
    await deleteObject(track.s3Key);
  } catch {
    // Orphaned object beats a track row pointing at deleted audio.
  }
  return new NextResponse(null, { status: 204 });
}
