import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, tracks, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { deleteObject } from "@/lib/s3";
import { nameSchema, updateDisplayName } from "@/lib/users";

const schema = z.object({ email: z.string() });
const patchSchema = z.object({ name: nameSchema });

// Rename the signed-in user. The database session reads users.name fresh per
// request, so the new name surfaces everywhere on the client's next refresh.
export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }
  return NextResponse.json({
    name: await updateDisplayName(user.id, parsed.data.name),
  });
}

// Deletes the signed-in user's own account. Typing the account email is a
// confirmation gate (the security boundary is requireUser — you can only delete
// yourself). Every user-owned table cascades off users.id, so the row delete
// clears all DB data (incl. the current session); S3 objects are not covered by
// the cascade, so collect and best-effort delete them afterwards.
export async function DELETE(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.email.trim().toLowerCase() !== user.email.toLowerCase()
  ) {
    return NextResponse.json({ error: "Email does not match" }, { status: 400 });
  }

  const ownedTracks = await db
    .select({
      s3Key: tracks.s3Key,
      artS3Key: tracks.artS3Key,
      artThumbS3Key: tracks.artThumbS3Key,
    })
    .from(tracks)
    .where(eq(tracks.ownerId, user.id));
  const ownedPlaylists = await db
    .select({ coverS3Key: playlists.coverS3Key })
    .from(playlists)
    .where(eq(playlists.ownerId, user.id));

  await db.delete(users).where(eq(users.id, user.id));

  const s3Keys = [
    ...ownedTracks.flatMap((t) => [t.s3Key, t.artS3Key, t.artThumbS3Key]),
    ...ownedPlaylists.map((p) => p.coverS3Key),
  ].filter((k): k is string => k !== null);
  for (const key of s3Keys) {
    try {
      await deleteObject(key);
    } catch {
      // Orphaned object beats blocking account deletion on an S3 hiccup.
    }
  }

  return new NextResponse(null, { status: 204 });
}
