import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { deleteObjectsBestEffort } from "@/lib/s3";
import {
  deleteOwnedTrack,
  loadAccessibleTrack,
  loadOwnedLibraryTrack,
  toTrackDTO,
  trackMetadataPatchSchema,
  updateTrackMetadata,
  type OwnedTrackResult,
} from "@/lib/tracks";

type Params = RouteContext<"/api/tracks/[id]">;

function trackNotFound() {
  return NextResponse.json({ error: "Track not found" }, { status: 404 });
}

function ownedTrackError(status: Exclude<OwnedTrackResult["status"], "ok">) {
  if (status === "not_found") return trackNotFound();
  if (status === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(
    { error: "Use Suggested Imports to accept or reject this track" },
    { status: 409 }
  );
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const parsed = trackMetadataPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    // Access errors take precedence over an invalid body.
    const owned = await loadOwnedLibraryTrack(user.id, id);
    if (owned.status !== "ok") return ownedTrackError(owned.status);
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const result = await updateTrackMetadata(user.id, id, parsed.data);
  if (result.status !== "ok") return ownedTrackError(result.status);
  return NextResponse.json(toTrackDTO(result.track));
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const result = await loadAccessibleTrack(user.id, id);
  if (result.status === "not_found") return trackNotFound();
  if (result.status === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(toTrackDTO(result.track));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const result = await deleteOwnedTrack(user.id, id);
  if (result.status !== "ok") return ownedTrackError(result.status);
  await deleteObjectsBestEffort(result.objectKeys);
  return new NextResponse(null, { status: 204 });
}
