import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tracks, users } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import {
  canonicalFriendCopy,
  isLibraryTrack,
  notDuplicateOfOwn,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import type { TrackDTO, TrackSearchResultDTO } from "@/lib/types";
import { escapeLike, getUserSettings } from "@/lib/users";

export type SearchScope = "own" | "friends" | "all";

type SearchOptions = { limit?: number; lyricSnippets?: boolean };

/**
 * Full-text + substring search over the viewer's accessible library, ranked
 * by ts_rank then newest. With `lyricSnippets`, each hit carries a ~20-word
 * plain-text excerpt around the lyric match, matched words wrapped in « ».
 */
export function searchTracks(
  userId: string,
  q: string,
  scope: SearchScope,
  opts?: { limit?: number; lyricSnippets?: false }
): Promise<TrackDTO[]>;
export function searchTracks(
  userId: string,
  q: string,
  scope: SearchScope,
  opts: { limit?: number; lyricSnippets: true }
): Promise<TrackSearchResultDTO[]>;
export async function searchTracks(
  userId: string,
  rawQuery: string,
  scope: SearchScope,
  { limit = 100, lyricSnippets = false }: SearchOptions = {}
): Promise<TrackDTO[] | TrackSearchResultDTO[]> {
  const q = rawQuery.trim();
  if (!q) return [];

  let ownerIds: string[];
  let friendIds: string[] = [];
  if (scope === "own") {
    ownerIds = [userId];
  } else if (scope === "friends") {
    friendIds = await friendIdsOf(userId);
    ownerIds = friendIds;
  } else {
    friendIds = await friendIdsOf(userId);
    ownerIds = [userId, ...friendIds];
  }
  if (ownerIds.length === 0) return [];

  const query = sql`websearch_to_tsquery('simple', ${q})`;
  // Escape %/_ so searching for them matches literally (the tsquery branch
  // already treats the input as plain words).
  const pattern = `%${escapeLike(q)}%`;
  // tsquery covers lyrics (and ranked word matches); ILIKE covers substring
  // matches on the short fields that FTS cannot do.
  const matches = or(
    sql`${tracks}."search_vector" @@ ${query}`,
    sql`${tracks.title} ilike ${pattern}`,
    sql`${tracks.artist} ilike ${pattern}`,
    sql`${tracks.album} ilike ${pattern}`
  );

  // Friends' private tracks are invisible; own private tracks still match.
  const visible = or(eq(tracks.ownerId, userId), eq(tracks.isPrivate, false));

  // Hide friends' copies of songs the user already owns (own rows untouched).
  const { hideFriendDuplicates } = await getUserSettings(userId);
  const noFriendDupes =
    scope !== "own" && hideFriendDuplicates
      ? or(
          eq(tracks.ownerId, userId),
          and(notDuplicateOfOwn(userId), canonicalFriendCopy(friendIds))
        )
      : undefined;

  const rows = await db
    .select({
      track: trackDtoColumns,
      ownerName: users.name,
      rank: sql<number>`ts_rank(${tracks}."search_vector", ${query})`,
    })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        inArray(tracks.ownerId, ownerIds),
        visible,
        matches,
        noFriendDupes
      )
    )
    .orderBy(({ rank }) => [desc(rank), desc(tracks.createdAt)])
    .limit(limit);

  const dtos = rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
  if (!lyricSnippets || dtos.length === 0) return dtos;

  // A separate pass over the returned ids only, so the headline never runs
  // for rows the LIMIT discards.
  const snippets = await db
    .select({
      id: tracks.id,
      snippet: sql<string>`ts_headline('simple', ${tracks.lyrics}, ${query},
        'StartSel="«", StopSel="»", MinWords=10, MaxWords=20, MaxFragments=1')`,
    })
    .from(tracks)
    .where(
      and(
        inArray(tracks.id, dtos.map((t) => t.id)),
        sql`to_tsvector('simple', coalesce(${tracks.lyrics}, '')) @@ ${query}`
      )
    );
  const byId = new Map(snippets.map((s) => [s.id, s.snippet]));
  return dtos.map((t) => ({ ...t, lyricSnippet: byId.get(t.id) ?? null }));
}
