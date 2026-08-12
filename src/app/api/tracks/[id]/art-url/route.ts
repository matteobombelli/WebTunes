import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/lib/s3";
import { resolveTrackMedia, trackMediaError } from "@/lib/track-media";

// Presigned cover-art URL for offline download (mirrors stream-url). The
// download manager fetches this directly so it gets a CORS-readable body to
// cache, rather than the SW-intercepted /art redirect.
export async function GET(
  _req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/art-url">
) {
  const { id } = await params;
  const media = await resolveTrackMedia(id, "art");
  if (!media.ok) return trackMediaError(media.error);

  const { url, expiresAt } = await getPresignedGetUrl(media.key);
  return NextResponse.json({ url, expiresAt });
}
