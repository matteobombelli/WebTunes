import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/lib/s3";
import { resolveShareToken } from "@/lib/shares";

// Public, UNAUTHENTICATED cover art behind a share token (full art, not the
// 64px thumb — this also backs the Open Graph image). 404 when the token is
// unknown/expired or the track has no art. See the stream route for the token
// reasoning.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const track = await resolveShareToken(token);
  if (!track || !track.artS3Key) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { url } = await getPresignedGetUrl(track.artS3Key);
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=3000");
  return res;
}
