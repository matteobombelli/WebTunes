import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  addPlaylistTracks,
  getEditablePlaylist,
  reorderPlaylistTracks,
} from "@/lib/playlists";

type Params = RouteContext<"/api/playlists/[id]/tracks">;

const addSchema = z.union([
  z.object({ trackId: z.string().uuid() }),
  z.object({ trackIds: z.array(z.string().uuid()).min(1).max(500) }),
]);

// A missing/uneditable playlist is a 404 even when the body is also invalid.
async function invalidBody(id: string, userId: string, error: string) {
  if (!(await getEditablePlaylist(id, userId))) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return invalidBody(id, user.id, "trackId or trackIds is required");
  }
  const requestedIds =
    "trackId" in parsed.data ? [parsed.data.trackId] : parsed.data.trackIds;

  const result = await addPlaylistTracks(id, user.id, requestedIds);
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    case "track_not_found":
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    case "already_present":
      return NextResponse.json({ error: "Already in playlist" }, { status: 409 });
  }
  return NextResponse.json({ added: result.added.length }, { status: 200 });
}

const reorderSchema = z.object({
  // Bound JSON validation work; this remains far above a practical playlist.
  trackIds: z.array(z.string().uuid()).min(1).max(10_000),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const parsed = reorderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return invalidBody(id, user.id, "trackIds array is required");
  }

  const result = await reorderPlaylistTracks(id, user.id, parsed.data.trackIds);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  if (result.status === "invalid") {
    return NextResponse.json(
      { error: "trackIds must be exactly the playlist's current tracks" },
      { status: 400 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
