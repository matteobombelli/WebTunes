import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { playlistTracks, tracks } from "@/db/schema";
import { isLibraryTrack, toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type {
  LibraryIssueKind,
  LibraryIssuesDTO,
  LibraryIssueTrackDTO,
} from "@/lib/types";

// Rough audio bitrate. Embedded cover art counts toward fileSize, so this
// overestimates, most for short tracks with large art.
const estimatedKbps = sql<string | null>`case
  when ${tracks.fileSize} > 0 and ${tracks.durationSec} > 0
  then ${tracks.fileSize} * 8.0 / ${tracks.durationSec} / 1000
end`;

// Same normalisation as notDuplicateOfOwn.
const titleKey = sql<string>`lower(btrim(${tracks.title}))`;
const artistKey = sql<string>`lower(btrim(coalesce(${tracks.artist}, '')))`;

function isBlank(column: typeof tracks.artist | typeof tracks.album) {
  return sql`btrim(coalesce(${column}, '')) = ''`;
}

/**
 * Metadata and quality problems in the user's own library. `low_bitrate`
 * uses an estimate from fileSize and durationSec (embedded art inflates it),
 * skipping tracks missing either; `minKbps` defaults to 128.
 * `possible_duplicates` pages over groups of 2+ own tracks sharing a
 * normalised title + artist; `total` then counts groups. Each track carries
 * its playlist count so the caller can tell which copy to keep.
 */
export async function findLibraryIssues(
  userId: string,
  kind: LibraryIssueKind,
  opts: { limit: number; offset?: number; minKbps?: number }
): Promise<LibraryIssuesDTO> {
  const own = and(eq(tracks.ownerId, userId), isLibraryTrack());
  const offset = opts.offset ?? 0;

  if (kind === "possible_duplicates") {
    const groups = () =>
      db
        .select({
          titleKey: titleKey.as("title_key"),
          artistKey: artistKey.as("artist_key"),
        })
        .from(tracks)
        .where(own)
        .groupBy(titleKey, artistKey)
        .having(sql`count(*) >= 2`);
    const [[{ total }], page] = await Promise.all([
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(groups().as("groups")),
      groups().orderBy(titleKey, artistKey).limit(opts.limit).offset(offset),
    ]);
    if (page.length === 0) return { kind, total, items: [] };

    const keys = sql.join(
      page.map((g) => sql`(${g.titleKey}, ${g.artistKey})`),
      sql`, `
    );
    const members = await issueTracks(
      and(own, sql`(${titleKey}, ${artistKey}) in (${keys})`),
      [asc(tracks.createdAt), asc(tracks.id)]
    );
    const byKey = new Map<string, LibraryIssueTrackDTO[]>();
    for (const { key, item } of members) {
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    }
    return {
      kind,
      total,
      items: page.map((g) => ({
        tracks: byKey.get(JSON.stringify([g.titleKey, g.artistKey])) ?? [],
      })),
    };
  }

  const condition = {
    missing_artist: isBlank(tracks.artist),
    missing_album: isBlank(tracks.album),
    missing_art: sql`${tracks.artS3Key} is null`,
    low_bitrate: sql`${estimatedKbps} < ${opts.minKbps ?? 128}`,
  }[kind];
  const where = and(own, condition);
  const order =
    kind === "low_bitrate"
      ? [asc(estimatedKbps), asc(tracks.id)]
      : [desc(tracks.createdAt), desc(tracks.id)];
  const [[{ total }], items] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(tracks)
      .where(where),
    issueTracks(where, order, opts.limit, offset),
  ]);
  return { kind, total, items: items.map((r) => r.item) };
}

async function issueTracks(
  where: SQL | undefined,
  order: SQL[],
  limit?: number,
  offset = 0
): Promise<{ key: string; item: LibraryIssueTrackDTO }[]> {
  const query = db
    .select({ track: trackDtoColumns, estimatedKbps, titleKey, artistKey })
    .from(tracks)
    .where(where)
    .orderBy(...order)
    .offset(offset);
  const rows = await (limit === undefined ? query : query.limit(limit));
  if (rows.length === 0) return [];

  // playlist_tracks is keyed (playlist_id, track_id), so this track_id lookup
  // scans the table; acceptable for one page of ids.
  const counts = await db
    .select({
      trackId: playlistTracks.trackId,
      count: sql<number>`count(*)::int`,
    })
    .from(playlistTracks)
    .where(
      inArray(playlistTracks.trackId, rows.map((r) => r.track.id))
    )
    .groupBy(playlistTracks.trackId);
  const countById = new Map(counts.map((c) => [c.trackId, c.count]));

  return rows.map((r) => ({
    key: JSON.stringify([r.titleKey, r.artistKey]),
    item: {
      track: toTrackDTO(r.track),
      estimatedKbps:
        r.estimatedKbps === null ? null : Math.round(Number(r.estimatedKbps)),
      playlistCount: countById.get(r.track.id) ?? 0,
    },
  }));
}
