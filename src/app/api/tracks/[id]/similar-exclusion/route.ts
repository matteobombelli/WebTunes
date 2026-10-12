import { NextRequest, NextResponse } from "next/server";
import { isForeignKeyViolation } from "@/db";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { addExclusion, removeExclusion } from "@/lib/exclusions";
import { loadAccessibleTrack } from "@/lib/tracks";
import { isUuid } from "@/lib/validate";

// Per-listener "exclude from Play Similar" toggle: POST excludes the track from
// the caller's radio, DELETE re-includes it. Self-scoped, but adding requires
// access: the exclusion list returns full track metadata, so an unchecked add
// would disclose any track whose id is known. Also intentional public surface
// for a future mobile client.
export async function POST(
  _req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/similar-exclusion">
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const access = await loadAccessibleTrack(user.id, id);
  if (access.status !== "ok") {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  try {
    await addExclusion(user.id, id);
  } catch (err) {
    // The only FK the row references is the track, so a violation means it's
    // gone (e.g. a stale client) - a 404, not a 500.
    if (isForeignKeyViolation(err)) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }
    throw err;
  }
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/similar-exclusion">
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  await removeExclusion(user.id, id);
  return new NextResponse(null, { status: 204 });
}
