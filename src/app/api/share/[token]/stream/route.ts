import { NextRequest, NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/lib/s3";
import { resolveShareToken } from "@/lib/shares";

// Public, UNAUTHENTICATED audio stream behind a share token. Mirrors
// /api/tracks/[id]/stream (302 to a rotating presigned S3 URL — the server never
// proxies audio), but the token is the authorization: no requireUser /
// canAccessTrack, and an expired/unknown token just resolves to null → 404. The
// token is base64url, never a uuid, so we do NOT run isUuid on it.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const track = await resolveShareToken(token);
  if (!track) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { url } = await getPresignedGetUrl(track.s3Key);
  // Per-browser cache under the 1h presign TTL, like the authed stream route.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, max-age=3000");
  return res;
}
