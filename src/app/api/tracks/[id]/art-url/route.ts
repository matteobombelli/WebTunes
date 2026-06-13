import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { getPresignedGetUrl } from "@/lib/s3";
import { isUuid } from "@/lib/validate";

// Presigned cover-art URL for offline download (mirrors stream-url). The
// download manager fetches this directly so it gets a CORS-readable body to
// cache, rather than the SW-intercepted /art redirect.
export async function GET(
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
    .select({
      id: tracks.id,
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
      artS3Key: tracks.artS3Key,
    })
    .from(tracks)
    .where(eq(tracks.id, id));
  if (!track || !track.artS3Key) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (!(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { url, expiresAt } = await getPresignedGetUrl(track.artS3Key);
  return NextResponse.json({ url, expiresAt });
}
