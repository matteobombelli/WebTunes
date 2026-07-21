import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { getPresignedGetUrl } from "@/lib/s3";
import { isUuid } from "@/lib/validate";

// Stable per-track stream URL: the player (and the service worker's offline
// cache) key on this URL, while the redirect target rotates per request.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  // The track row doesn't depend on the session, so fetch both concurrently -
  // one less serial DB hop between the click and the presigned redirect.
  const [user, [track]] = await Promise.all([
    requireUser(),
    db
      .select({
        id: tracks.id,
        ownerId: tracks.ownerId,
        isPrivate: tracks.isPrivate,
        suggestedImportId: tracks.suggestedImportId,
        s3Key: tracks.s3Key,
      })
      .from(tracks)
      .where(eq(tracks.id, id)),
  ]);
  if (!user) return unauthorized();
  if (!track) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const canPreview = track.suggestedImportId && track.ownerId === user.id;
  if (!canPreview && !(await canAccessTrack(user.id, track))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { url } = await getPresignedGetUrl(track.s3Key);
  // Cache the redirect per-browser, under the 1h presigned-URL TTL, so replaying
  // or skipping back to the same track reuses it without a fresh auth + DB +
  // presign hop. The SW's offline cache (keyed on this stable path) is checked
  // first on a cache hit; this only affects the online cache-miss path.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=3000");
  return res;
}
