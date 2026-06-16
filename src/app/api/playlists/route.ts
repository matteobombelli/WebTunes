import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  listAccessiblePlaylists,
  listPlaylistsWithCount,
  toPlaylistDTO,
} from "@/lib/playlists";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  // scope=all additionally includes friends' non-private playlists.
  if (req.nextUrl.searchParams.get("scope") === "all") {
    return NextResponse.json(await listAccessiblePlaylists(user.id));
  }
  return NextResponse.json(await listPlaylistsWithCount(user.id));
}

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Playlist name is required" }, { status: 400 });
  }

  const [playlist] = await db
    .insert(playlists)
    .values({ ownerId: user.id, name: parsed.data.name })
    .returning();
  return NextResponse.json(await toPlaylistDTO(playlist, 0), { status: 201 });
}
