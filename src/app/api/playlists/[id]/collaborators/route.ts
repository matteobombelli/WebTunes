import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isUniqueViolation } from "@/db";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { areFriends } from "@/lib/friends";
import {
  addCollaborator,
  getEditablePlaylist,
  getOwnPlaylist,
  listCollaborators,
  removeCollaborator,
} from "@/lib/playlists";
import { isUuid } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

// List collaborators — visible to anyone who can edit the playlist.
export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getEditablePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return NextResponse.json(await listCollaborators(id));
}

const addSchema = z.object({ userId: z.string().uuid() });

// Add a collaborator — owner only; the collaborator must be an accepted friend.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  const { userId } = parsed.data;
  if (userId === user.id) {
    return NextResponse.json(
      { error: "You already own this playlist" },
      { status: 400 }
    );
  }
  if (!(await areFriends(user.id, userId))) {
    return NextResponse.json(
      { error: "You can only add friends as collaborators" },
      { status: 403 }
    );
  }

  try {
    await addCollaborator(id, userId);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "Already a collaborator" },
        { status: 409 }
      );
    }
    throw err;
  }
  return NextResponse.json(await listCollaborators(id), { status: 201 });
}

// Remove a collaborator — the owner may remove anyone; a collaborator may remove
// themselves ("leave"). Anyone else is forbidden.
export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const userId = req.nextUrl.searchParams.get("userId") ?? "";
  if (!isUuid(userId)) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const owned = await getOwnPlaylist(id, user.id);
  const isSelfLeave = userId === user.id;
  if (!owned && !isSelfLeave) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!owned) {
    // A non-owner may only remove themselves, and only if they can edit it.
    const editable = await getEditablePlaylist(id, user.id);
    if (!editable) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
  }

  await removeCollaborator(id, userId);
  return new NextResponse(null, { status: 204 });
}
