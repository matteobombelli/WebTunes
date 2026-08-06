import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { duplicatePlaylist } from "@/lib/playlists";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const copy = await duplicatePlaylist(id, user.id);
  if (!copy) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  return NextResponse.json(copy, { status: 201 });
}
