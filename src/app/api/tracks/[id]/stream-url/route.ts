import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/lib/s3";
import { resolveTrackMedia, trackMediaError } from "@/lib/track-media";

export async function GET(
  _req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/stream-url">
) {
  const { id } = await params;
  const media = await resolveTrackMedia(id, "audio");
  if (!media.ok) return trackMediaError(media.error);

  const { url, expiresAt } = await getPresignedGetUrl(media.key);
  return NextResponse.json({ url, expiresAt });
}
