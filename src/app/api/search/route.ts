import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { friendIdsOf } from "@/lib/friends";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const scope = req.nextUrl.searchParams.get("scope") ?? "all";
  if (!q) return NextResponse.json([]);

  let ownerIds: string[];
  if (scope === "own") {
    ownerIds = [user.id];
  } else if (scope === "friends") {
    ownerIds = await friendIdsOf(user.id);
  } else {
    ownerIds = [user.id, ...(await friendIdsOf(user.id))];
  }
  if (ownerIds.length === 0) return NextResponse.json([]);

  const pattern = `%${q}%`;
  // tsquery covers lyrics (and ranked word matches); ILIKE covers substring
  // matches on the short fields that FTS cannot do.
  const matches = or(
    sql`${tracks}."search_vector" @@ websearch_to_tsquery('simple', ${q})`,
    sql`${tracks.title} ilike ${pattern}`,
    sql`${tracks.artist} ilike ${pattern}`,
    sql`${tracks.album} ilike ${pattern}`
  );

  const rows = await db
    .select({
      track: tracks,
      ownerName: users.name,
      rank: sql<number>`ts_rank(${tracks}."search_vector", websearch_to_tsquery('simple', ${q}))`,
    })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(and(inArray(tracks.ownerId, ownerIds), matches))
    .orderBy(({ rank }) => [desc(rank), desc(tracks.createdAt)])
    .limit(100);

  return NextResponse.json(
    rows.map((r) => ({
      ...r.track,
      createdAt: r.track.createdAt.toISOString(),
      ownerName: r.track.ownerId === user.id ? null : r.ownerName,
    }))
  );
}
