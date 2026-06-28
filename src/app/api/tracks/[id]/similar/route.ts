import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { findSimilarTracks } from "@/lib/similar";
import { isUuid } from "@/lib/validate";

// Tracks similar to the seed track (by CLAP-embedding cosine, with the viewer's
// variation level mixed in), for "play similar". POST so the client can send
// the already-served ids (`excludeIds`) — which grow over a session — in the
// body rather than a length-capped query string. Also serves the future mobile
// client. Fewer than `limit` results means the similar pool is exhausted.
const bodySchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  excludeIds: z.array(z.string().uuid()).max(10_000).default([]),
  // When given, ranking is limited to this candidate set — Discover uses it so a
  // tapped song's similar mix stays inside the section it came from.
  withinIds: z.array(z.string().uuid()).max(500).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const tracks = await findSimilarTracks(user.id, id, parsed.data);
  return NextResponse.json({ tracks });
}
