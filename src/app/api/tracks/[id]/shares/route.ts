import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import {
  createOrGetShare,
  deleteShare,
  getActiveShare,
  type ShareLink,
} from "@/lib/shares";
import { isUuid } from "@/lib/validate";

// Manage a track's public share link. Anyone who can ACCESS the track may mint/
// read the link (POST/GET, gated on canAccessTrack — minting is idempotent and
// additive); only the track's OWNER may revoke it (DELETE), so a friend can't
// kill or rotate the owner's distributed URL. The matching public (no-auth)
// endpoints that serve the audio/art live under /api/share/[token].

function shareBody(link: ShareLink, headers: Headers) {
  return {
    url: `${getAppBaseUrl(headers)}/share/${link.token}`,
    token: link.token,
    expiresAt: link.expiresAt.toISOString(),
  };
}

// 404 (not 403) for a missing OR inaccessible track: don't reveal track ids the
// viewer can't see. Anyone who can ACCESS a track (its owner, or a friend for a
// non-private track) may share it — the resulting link is then an absolute
// capability that ignores later privacy/friendship changes (see lib/shares).
async function requireShareableTrack(
  id: string,
  userId: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [track] = await db
    .select({ ownerId: tracks.ownerId, isPrivate: tracks.isPrivate })
    .from(tracks)
    .where(eq(tracks.id, id));
  return !!track && (await canAccessTrack(userId, track));
}

// Revocation is owner-only (see header). Same 404-for-inaccessible behaviour.
async function requireOwnedTrack(
  id: string,
  userId: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [track] = await db
    .select({ ownerId: tracks.ownerId })
    .from(tracks)
    .where(eq(tracks.id, id));
  return !!track && track.ownerId === userId;
}

const notFound = () =>
  NextResponse.json({ error: "Track not found" }, { status: 404 });

// Current active link (or null). No web UI calls this now (the kebab copies
// directly via POST); kept as read surface for a future mobile client.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!(await requireShareableTrack(id, user.id))) return notFound();
  const link = await getActiveShare(id);
  return NextResponse.json(link ? shareBody(link, req.headers) : null);
}

// Create the link (idempotent: returns the existing active one if present).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!(await requireShareableTrack(id, user.id))) return notFound();
  const link = await createOrGetShare(id, user.id);
  return NextResponse.json(shareBody(link, req.headers));
}

// Revoke the link.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!(await requireOwnedTrack(id, user.id))) return notFound();
  await deleteShare(id);
  return new NextResponse(null, { status: 204 });
}
