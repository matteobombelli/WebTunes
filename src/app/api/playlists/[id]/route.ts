import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  deleteOwnedPlaylist,
  getEditablePlaylist,
  getPlaylistWithTracks,
  toPlaylistDTO,
  updatePlaylist,
} from "@/lib/playlists";
import { deleteObjectsBestEffort } from "@/lib/s3";

type Params = RouteContext<"/api/playlists/[id]">;

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getPlaylistWithTracks(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return NextResponse.json(playlist);
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isPrivate !== undefined, {
    message: "Nothing to update",
  });

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // An inaccessible playlist is a 404 even when the body is also invalid.
    if (!(await getEditablePlaylist(id, user.id))) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Invalid playlist update" }, { status: 400 });
  }

  const result = await updatePlaylist(id, user.id, parsed.data);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  if (result.status === "forbidden") {
    return NextResponse.json(
      { error: "Only the owner can change privacy" },
      { status: 403 }
    );
  }
  return NextResponse.json(await toPlaylistDTO(result.playlist));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const result = await deleteOwnedPlaylist(id, user.id);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  await deleteObjectsBestEffort(result.objectKeys);
  return new NextResponse(null, { status: 204 });
}
