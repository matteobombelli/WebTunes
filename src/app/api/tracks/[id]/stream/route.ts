import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/lib/s3";
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
  // This stable URL is shared by every account in a browser profile. Never let
  // its authenticated redirect survive a logout/account switch.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
