import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { findSimilarTracks } from "@/lib/similar";
import { isUuid } from "@/lib/validate";

// Tracks similar to the seed track (by CLAP-embedding cosine), for "play
// similar". The client seeds with offset=0 and paginates (offset += batch) to
// pull fresh, non-repeating batches; fewer than `limit` results means the pool
// is exhausted. Also serves the future mobile client.
const querySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  const parsed = querySchema.safeParse({
    offset: req.nextUrl.searchParams.get("offset") ?? undefined,
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  const tracks = await findSimilarTracks(user.id, id, parsed.data);
  return NextResponse.json({ tracks });
}
