import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getAccessiblePlaylist } from "@/lib/playlists";
import { findPlaylistRecommendations } from "@/lib/similar";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  // Already-shown ids to skip, so "refresh / show more" doesn't repeat.
  excludeIds: z.array(z.string().uuid()).max(500).optional(),
});

// Recommend tracks to add to a playlist, seeded from its own tracks (same
// multi-centroid recommender as Discover). Visible to anyone who can view the
// playlist; results are access-filtered to the viewer.
export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getAccessiblePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { limit = 20, excludeIds = [] } = parsed.data;

  const recommendations = await findPlaylistRecommendations(user.id, id, {
    limit,
    excludeIds,
  });
  return NextResponse.json(recommendations);
}
