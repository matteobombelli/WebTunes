import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { friendIdsOf } from "@/lib/friends";
import { notDuplicateOfOwn, toTrackDTO } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";

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

  // Friends' private tracks are invisible; own private tracks still match.
  const visible = or(eq(tracks.ownerId, user.id), eq(tracks.isPrivate, false));

  // Hide friends' copies of songs the user already owns (own rows untouched).
  const { hideFriendDuplicates } = await getUserSettings(user.id);
  const noFriendDupes =
    scope !== "own" && hideFriendDuplicates
      ? or(eq(tracks.ownerId, user.id), notDuplicateOfOwn(user.id))
      : undefined;

  const rows = await db
    .select({
      track: tracks,
      ownerName: users.name,
      rank: sql<number>`ts_rank(${tracks}."search_vector", websearch_to_tsquery('simple', ${q}))`,
    })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(and(inArray(tracks.ownerId, ownerIds), visible, matches, noFriendDupes))
    .orderBy(({ rank }) => [desc(rank), desc(tracks.createdAt)])
    .limit(100);

  return NextResponse.json(
    rows.map((r) =>
      toTrackDTO(r.track, r.track.ownerId === user.id ? null : r.ownerName)
    )
  );
}
