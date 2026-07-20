import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, isUniqueViolation } from "@/db";
import { playlists, playlistTracks, tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { canAccessTrackWithFriends, friendIdsOf } from "@/lib/friends";
import { getEditablePlaylist } from "@/lib/playlists";

type Params = { params: Promise<{ id: string }> };

const addSchema = z.union([
  z.object({ trackId: z.string().uuid() }),
  z.object({ trackIds: z.array(z.string().uuid()).min(1).max(500) }),
]);

export async function POST(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getEditablePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "trackId or trackIds is required" },
      { status: 400 }
    );
  }
  const requestedIds =
    "trackId" in parsed.data ? [parsed.data.trackId] : parsed.data.trackIds;

  const candidates = await db
    .select({
      id: tracks.id,
      ownerId: tracks.ownerId,
      isPrivate: tracks.isPrivate,
    })
    .from(tracks)
    .where(inArray(tracks.id, requestedIds));
  if (candidates.length !== requestedIds.length) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const friendIds = await friendIdsOf(user.id);
  for (const track of candidates) {
    if (!canAccessTrackWithFriends(user.id, track, friendIds)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const existing = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(
      and(
        eq(playlistTracks.playlistId, id),
        inArray(playlistTracks.trackId, requestedIds)
      )
    );
  const existingIds = new Set(existing.map((e) => e.trackId));
  // Preserve request order; skip tracks already in the playlist (when nothing
  // is left to add, that's the 409 below).
  const toAdd = requestedIds.filter((tid) => !existingIds.has(tid));
  if (toAdd.length === 0) {
    return NextResponse.json({ error: "Already in playlist" }, { status: 409 });
  }

  try {
    await db.transaction(async (tx) => {
      const [{ base }] = await tx
        .select({
          base: sql<number>`coalesce(max(${playlistTracks.position}) + 1, 0)::int`,
        })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, id));
      await tx.insert(playlistTracks).values(
        toAdd.map((trackId, i) => ({
          playlistId: id,
          trackId,
          position: base + i,
        }))
      );
      await tx
        .update(playlists)
        .set({ updatedAt: new Date() })
        .where(eq(playlists.id, id));
    });
  } catch (err) {
    // Two concurrent adds can both pass the membership check above; the
    // (playlist_id, track_id) PK catches the loser.
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: "Already in playlist" }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ added: toAdd.length }, { status: 200 });
}

const reorderSchema = z.object({
  // Cap the array so one request can't block the event loop on the JSON+zod
  // pass (the proxy buffers up to 100mb). Far above any real playlist; adds
  // are capped at 500.
  trackIds: z.array(z.string().uuid()).min(1).max(10_000),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const playlist = await getEditablePlaylist(id, user.id);
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const parsed = reorderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "trackIds array is required" }, { status: 400 });
  }

  // A reorder must be a permutation of the playlist's CURRENT members - reject a
  // partial / padded / duplicated list so positions can't end up colliding or
  // non-contiguous (the web client always sends the full ordered list).
  const members = await db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, id));
  const submitted = parsed.data.trackIds;
  const submittedSet = new Set(submitted);
  const memberSet = new Set(members.map((m) => m.trackId));
  const isPermutation =
    submitted.length === submittedSet.size && // no duplicates
    submittedSet.size === memberSet.size &&
    [...submittedSet].every((tid) => memberSet.has(tid));
  if (!isPermutation) {
    return NextResponse.json(
      { error: "trackIds must be exactly the playlist's current tracks" },
      { status: 400 }
    );
  }

  await db.transaction(async (tx) => {
    // One set-based statement instead of one UPDATE per track: a drag-drop in a
    // large playlist would otherwise hold the transaction (and row locks) across
    // hundreds of sequential round-trips. sql.param keeps the id array a single
    // $1::uuid[] parameter - plain ${array} interpolation expands to ($1, $2, …),
    // which Postgres can't cast to uuid[].
    await tx.execute(sql`
      update ${playlistTracks} set "position" = v.ord - 1
      from unnest(${sql.param(parsed.data.trackIds)}::uuid[]) with ordinality as v(track_id, ord)
      where ${playlistTracks.playlistId} = ${id}
        and ${playlistTracks.trackId} = v.track_id
    `);
    await tx
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, id));
  });
  return new NextResponse(null, { status: 204 });
}
