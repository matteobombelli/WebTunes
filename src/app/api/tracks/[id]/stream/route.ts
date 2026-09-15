import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl, PRESIGN_REUSE_SEC } from "@/lib/s3";
import { resolveTrackMedia, trackMediaError } from "@/lib/track-media";

// Stable per-track stream URL: the player (and the service worker's offline
// cache) key on this URL, while the redirect target rotates per request.
export async function GET(
  _req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/stream">
) {
  const { id } = await params;
  const media = await resolveTrackMedia(id, "audio");
  if (!media.ok) return trackMediaError(media.error);

  const { url } = await getPresignedGetUrl(media.key);
  // Cached for the presign reuse window so a replayed track skips both the app
  // hop and a re-signed redirect. `private` keeps it out of shared caches; the
  // stable URL is shared by every account in a browser profile, so an account
  // switch can reuse an already-minted stream URL for at most that window.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", `private, max-age=${PRESIGN_REUSE_SEC}`);
  return res;
}
