import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, playlistTracks, tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { deleteObject } from "@/lib/s3";
import { toTrackDTO } from "@/lib/tracks";
import { isUuid } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

function trackNotFound() {
  return NextResponse.json({ error: "Track not found" }, { status: 404 });
}

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
  if (!isUuid(id)) return trackNotFound();
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) return trackNotFound();
  if (track.ownerId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (track.suggestedImportId) {
    return NextResponse.json(
      { error: "Use Suggested Imports to accept or reject this track" },
      { status: 409 }
    );
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
  // Deleted between the ownership check and the update.
  if (!updated) return trackNotFound();
  return NextResponse.json(toTrackDTO(updated));
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) return trackNotFound();
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) return trackNotFound();
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(toTrackDTO(track));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) return trackNotFound();
  const [track] = await db.select().from(tracks).where(eq(tracks.id, id));
  if (!track) return trackNotFound();
  if (track.ownerId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (track.suggestedImportId) {
    return NextResponse.json(
      { error: "Use Suggested Imports to accept or reject this track" },
      { status: 409 }
    );
  }

  // Deleting a track cascades rows out of playlists (the owner's and
  // friends'); bump those playlists' updatedAt first, per the convention that
  // content changes touch it.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update ${playlists} set updated_at = now()
      where ${playlists.id} in (
        select ${playlistTracks.playlistId} from ${playlistTracks}
        where ${playlistTracks.trackId} = ${id}
      )
    `);
    await tx.delete(tracks).where(eq(tracks.id, id));
  });
  try {
    await deleteObject(track.s3Key);
    if (track.artS3Key) await deleteObject(track.artS3Key);
    if (track.artThumbS3Key) await deleteObject(track.artThumbS3Key);
  } catch {
    // Orphaned object beats a track row pointing at deleted audio.
  }
  return new NextResponse(null, { status: 204 });
}
