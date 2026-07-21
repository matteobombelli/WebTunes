import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tracks, users, type Track } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import type { TrackDTO, TrackPageDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

/**
 * Columns the TrackDTO needs from `tracks`. Deliberately excludes `lyrics` /
 * `lyricsSource` (never read by the client - they only feed `search_vector`),
 * `contentHash` (a server-side dedupe detail), and `s3Key` (playback goes
 * through the /stream route; the bucket layout stays server-side). List
 * queries select this projection so they don't ship KBs of lyrics per row.
 */
export const trackDtoColumns = {
  id: tracks.id,
  ownerId: tracks.ownerId,
  title: tracks.title,
  artist: tracks.artist,
  album: tracks.album,
  durationSec: tracks.durationSec,
  loudnessLufs: tracks.loudnessLufs,
  artS3Key: tracks.artS3Key,
  mimeType: tracks.mimeType,
  fileSize: tracks.fileSize,
  isPrivate: tracks.isPrivate,
  friendPlayCount: tracks.friendPlayCount,
  createdAt: tracks.createdAt,
};

/** Normal library rows only. Suggested-import previews deliberately live in
 * tracks so they can reuse playback/art/ingest, but must never leak into any
 * ordinary collection, search, friend, playlist, or recommendation query. */
export function isLibraryTrack() {
  return isNull(tracks.suggestedImportId);
}

type TrackRow = Pick<Track, keyof typeof trackDtoColumns>;

type TrackCursor = { createdAt: string; id: string };

// Keep the database's microsecond precision in the cursor. A JS Date only has
// millisecond precision, which could otherwise skip tracks created inside the
// same millisecond at a page boundary.
const cursorCreatedAt = sql<string>`${tracks.createdAt}::text`;

const POSTGRES_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

function isCursorTimestamp(value: string): boolean {
  const match = POSTGRES_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(
    Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2],
      parts[3],
      parts[4],
      parts[5],
      Number(fraction.padEnd(3, "0").slice(0, 3))
    )
  );
  return (
    parts[0] >= 1000 &&
    date.getUTCFullYear() === parts[0] &&
    date.getUTCMonth() === parts[1] - 1 &&
    date.getUTCDate() === parts[2] &&
    date.getUTCHours() === parts[3] &&
    date.getUTCMinutes() === parts[4] &&
    date.getUTCSeconds() === parts[5]
  );
}

export function parseTrackCursor(value: string): TrackCursor | null {
  if (!value || value.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !isCursorTimestamp(parsed[0]) ||
      !isUuid(parsed[1])
    ) {
      return null;
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString(
    "base64url"
  );
}

function afterTrackCursor(cursor?: TrackCursor) {
  if (!cursor) return undefined;
  const cursorTime = sql`cast(${cursor.createdAt} as timestamp)`;
  return or(
    lt(tracks.createdAt, cursorTime),
    and(eq(tracks.createdAt, cursorTime), lt(tracks.id, cursor.id))
  );
}

function toTrackPage<T extends { cursorCreatedAt: string; track: TrackRow }>(
  rows: T[],
  limit: number,
  map: (row: T) => TrackDTO
): TrackPageDTO {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    tracks: pageRows.map(map),
    nextCursor:
      rows.length > limit && last
        ? encodeTrackCursor({
            createdAt: last.cursorCreatedAt,
            id: last.track.id,
          })
        : null,
  };
}

/**
 * ownerName should be null for the viewer's own tracks. Built field-by-field so
 * it can't leak excluded columns (lyrics/contentHash) even when handed a full
 * row from a `select()` (e.g. the upload/detail paths).
 */
export function toTrackDTO(
  track: TrackRow,
  ownerName: string | null = null
): TrackDTO {
  return {
    id: track.id,
    ownerId: track.ownerId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    loudnessLufs: track.loudnessLufs,
    artS3Key: track.artS3Key,
    mimeType: track.mimeType,
    fileSize: track.fileSize,
    isPrivate: track.isPrivate,
    friendPlayCount: track.friendPlayCount,
    createdAt: track.createdAt.toISOString(),
    ownerName,
  };
}

/**
 * SQL filter: the (outer) tracks row is not a duplicate of one of the
 * viewer's own tracks. "Duplicate" = same title + artist, case- and
 * whitespace-insensitive. Apply to friend-owned rows only.
 */
export function notDuplicateOfOwn(userId: string) {
  return sql`not exists (
    select 1 from ${tracks} own
    where own.owner_id = ${userId}
      and own.suggested_import_id is null
      and lower(btrim(own.title)) = lower(btrim(${tracks.title}))
      and lower(btrim(coalesce(own.artist, ''))) = lower(btrim(coalesce(${tracks.artist}, '')))
  )`;
}

/**
 * SQL filter (apply to friend-owned rows): this friend's copy is the canonical
 * one for its song - i.e. no OTHER friend has a copy of the same title + artist
 * (case/whitespace-insensitive) with a smaller id. Collapses the same song
 * owned by two different friends down to a single (lowest-id) row. `friendIds`
 * must be the viewer's friends, so an inaccessible stranger's copy can never
 * suppress a friend's track. Returns undefined when there are no friends -
 * nothing to dedupe. Pair with notDuplicateOfOwn so own copies always win.
 */
export function canonicalFriendCopy(friendIds: string[]) {
  if (!friendIds.length) return undefined;
  const ids = sql.join(
    friendIds.map((id) => sql`${id}`),
    sql`, `
  );
  return sql`not exists (
    select 1 from ${tracks} other
    where other.id < ${tracks.id}
      and other.suggested_import_id is null
      and other.owner_id in (${ids})
      and other.is_private = false
      and lower(btrim(other.title)) = lower(btrim(${tracks.title}))
      and lower(btrim(coalesce(other.artist, ''))) = lower(btrim(coalesce(${tracks.artist}, '')))
  )`;
}

/** The user's own tracks, newest first. `limit` caps the result (the library
 *  page's partial first paint); omitted = the full library. */
export async function listOwnTracks(
  userId: string,
  limit?: number
): Promise<TrackDTO[]> {
  const query = db
    .select(trackDtoColumns)
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), isLibraryTrack()))
    .orderBy(desc(tracks.createdAt));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((t) => toTrackDTO(t));
}

/** A keyset-paginated slice of the user's own newest-first tracks. */
export async function listOwnTracksPage(
  userId: string,
  limit: number,
  cursor?: TrackCursor
): Promise<TrackPageDTO> {
  const rows = await db
    .select({ track: trackDtoColumns, cursorCreatedAt })
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), isLibraryTrack(), afterTrackCursor(cursor)))
    .orderBy(desc(tracks.createdAt), desc(tracks.id))
    .limit(limit + 1);
  return toTrackPage(rows, limit, (r) => toTrackDTO(r.track));
}

/** How many tracks the user owns - tells the library page whether its partial
 *  initial payload covers the whole library. */
export async function countOwnTracks(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), isLibraryTrack()));
  return row?.count ?? 0;
}

/**
 * Own tracks plus friends' non-private tracks, newest first. With
 * hideFriendDuplicates, friends' copies of songs the user already has
 * (per notDuplicateOfOwn) are excluded.
 */
export async function listAccessibleTracks(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
                hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
              )
            : sql`false`
        )
      )
    )
    .orderBy(desc(tracks.createdAt));
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/** A keyset-paginated slice of all tracks accessible to the viewer. */
export async function listAccessibleTracksPage(
  userId: string,
  hideFriendDuplicates: boolean,
  limit: number,
  cursor?: TrackCursor
): Promise<TrackPageDTO> {
  const friendIds = await friendIdsOf(userId);
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name, cursorCreatedAt })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
                hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
              )
            : sql`false`
        ),
        afterTrackCursor(cursor)
      )
    )
    .orderBy(desc(tracks.createdAt), desc(tracks.id))
    .limit(limit + 1);
  return toTrackPage(rows, limit, (r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/**
 * Friends' non-private tracks only (the viewer's own excluded), newest first -
 * the friends-scope library view. Same dedup rule as listAccessibleTracks, so
 * the server returns exactly this scope instead of the client filtering the
 * full accessible set down to it.
 */
export async function listFriendsTracks(
  userId: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  if (!friendIds.length) return [];
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        inArray(tracks.ownerId, friendIds),
        eq(tracks.isPrivate, false),
        hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
        hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
      )
    )
    .orderBy(desc(tracks.createdAt));
  return rows.map((r) => toTrackDTO(r.track, r.ownerName));
}

/** A keyset-paginated slice of friends' visible newest-first tracks. */
export async function listFriendsTracksPage(
  userId: string,
  hideFriendDuplicates: boolean,
  limit: number,
  cursor?: TrackCursor
): Promise<TrackPageDTO> {
  const friendIds = await friendIdsOf(userId);
  if (!friendIds.length) return { tracks: [], nextCursor: null };
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name, cursorCreatedAt })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        inArray(tracks.ownerId, friendIds),
        eq(tracks.isPrivate, false),
        hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
        hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined,
        afterTrackCursor(cursor)
      )
    )
    .orderBy(desc(tracks.createdAt), desc(tracks.id))
    .limit(limit + 1);
  return toTrackPage(rows, limit, (r) => toTrackDTO(r.track, r.ownerName));
}

/**
 * Accessible tracks (own + friends' non-private) whose `field` matches `value`
 * case- and whitespace-insensitively, ordered by title. Honors
 * hideFriendDuplicates like listAccessibleTracks. Backs the album/artist pages.
 */
async function listAccessibleTracksByField(
  userId: string,
  field: typeof tracks.album | typeof tracks.artist,
  value: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  const friendIds = await friendIdsOf(userId);
  const matches = sql`lower(btrim(coalesce(${field}, ''))) = lower(btrim(${value}))`;
  const rows = await db
    .select({ track: trackDtoColumns, ownerName: users.name })
    .from(tracks)
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        isLibraryTrack(),
        matches,
        or(
          eq(tracks.ownerId, userId),
          friendIds.length
            ? and(
                inArray(tracks.ownerId, friendIds),
                eq(tracks.isPrivate, false),
                hideFriendDuplicates ? notDuplicateOfOwn(userId) : undefined,
                hideFriendDuplicates ? canonicalFriendCopy(friendIds) : undefined
              )
            : sql`false`
        )
      )
    )
    .orderBy(tracks.title);
  return rows.map((r) =>
    toTrackDTO(r.track, r.track.ownerId === userId ? null : r.ownerName)
  );
}

/** Accessible tracks on a given album. */
export function listTracksByAlbum(
  userId: string,
  album: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  return listAccessibleTracksByField(
    userId,
    tracks.album,
    album,
    hideFriendDuplicates
  );
}

/** Accessible tracks by a given artist. */
export function listTracksByArtist(
  userId: string,
  artist: string,
  hideFriendDuplicates: boolean
): Promise<TrackDTO[]> {
  return listAccessibleTracksByField(
    userId,
    tracks.artist,
    artist,
    hideFriendDuplicates
  );
}

/** One friend’s non-private tracks, newest first (distinct from the
 *  friends-scope listing listFriendsTracks). Caller checks the friendship. */
export async function listTracksOfFriend(
  friendId: string,
  ownerName: string | null
): Promise<TrackDTO[]> {
  const rows = await db
    .select(trackDtoColumns)
    .from(tracks)
    .where(
      and(
        eq(tracks.ownerId, friendId),
        eq(tracks.isPrivate, false),
        isLibraryTrack()
      )
    )
    .orderBy(desc(tracks.createdAt));
  return rows.map((t) => toTrackDTO(t, ownerName));
}
