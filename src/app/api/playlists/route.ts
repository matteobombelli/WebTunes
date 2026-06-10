import { desc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { playlists, playlistTracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { toPlaylistDTO } from "@/lib/playlists";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const rows = await db
    .select({
      playlist: playlists,
      trackCount: sql<number>`(select count(*)::int from ${playlistTracks}
        where ${playlistTracks.playlistId} = ${playlists.id})`,
    })
    .from(playlists)
    .where(eq(playlists.ownerId, user.id))
    .orderBy(desc(playlists.updatedAt));

  return NextResponse.json(
    await Promise.all(rows.map((r) => toPlaylistDTO(r.playlist, r.trackCount)))
  );
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
