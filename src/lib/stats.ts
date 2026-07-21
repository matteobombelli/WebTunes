import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { listens, tracks, users } from "@/db/schema";
import { friendIdsOf } from "@/lib/friends";
import { isLibraryTrack, toTrackDTO, trackDtoColumns } from "@/lib/tracks";
import type {
  StatsDailyActivityDTO,
  StatsDTO,
  StatsRange,
} from "@/lib/types";

const TOP_TRACK_LIMIT = 20;
const TOP_GROUP_LIMIT = 10;

/** Rejecting invalid zones before SQL avoids turning a bad query into a 500. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function periodStart(range: StatsRange, end: Date): Date {
  const start = new Date(end);
  if (range === "6m") {
    // Move through day 1 so dates such as August 31 clamp to February's end
    // instead of overflowing into March.
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 6);
    const lastDay = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
    ).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  } else if (range === "1y") {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
  } else {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    start.setUTCDate(start.getUTCDate() - days);
  }
  return start;
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function denseDays(
  start: Date,
  end: Date,
  timeZone: string,
  rows: Array<{ date: string; listens: number; listeningSeconds: number }>
): StatsDailyActivityDTO[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const first = new Date(`${localDateKey(start, timeZone)}T00:00:00Z`);
  const last = new Date(`${localDateKey(end, timeZone)}T00:00:00Z`);
  const out: StatsDailyActivityDTO[] = [];

  for (const cursor = first; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, listens: 0, listeningSeconds: 0 });
  }
  return out;
}

function longestStreak(days: StatsDailyActivityDTO[]): number {
  let longest = 0;
  let current = 0;
  for (const day of days) {
    current = day.listens > 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/**
 * Private listening analytics for one user. Anonymous totals use every surviving
 * personal listen event; itemized rankings use the viewer's current access rule
 * so an old friendship cannot expose track metadata that is no longer available.
 */
export async function getUserStats(
  userId: string,
  range: StatsRange,
  timeZone: string
): Promise<StatsDTO> {
  const end = new Date();
  const start = periodStart(range, end);
  const friendIds = await friendIdsOf(userId);
  const inPeriod = and(
    eq(listens.userId, userId),
    gte(listens.playedAt, start),
    lte(listens.playedAt, end)
  );
  const accessible = or(
    eq(tracks.ownerId, userId),
    friendIds.length
      ? and(inArray(tracks.ownerId, friendIds), eq(tracks.isPrivate, false))
      : sql`false`
  );
  const libraryPeriod = and(inPeriod, isLibraryTrack());
  // `played_at` is stored as a UTC timestamp without a zone. Convert it to the
  const localPlayedAt = sql`(${listens.playedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}`;
  const dayExpression = sql<string>`to_char(${localPlayedAt}, 'YYYY-MM-DD')`;
  const hourExpression = sql<number>`extract(hour from ${localPlayedAt})::int`;
  const contributedSeconds = sql`coalesce(${listens.listenedSeconds}, ${tracks.durationSec}, 0)`;

  const firstListens = db
    .select({
      trackId: listens.trackId,
      firstPlayedAt: sql<Date>`min(${listens.playedAt})`.as("first_played_at"),
    })
    .from(listens)
    .where(eq(listens.userId, userId))
    .groupBy(listens.trackId)
    .as("first_listens");

  const [
    totalsRows,
    dailyRows,
    hourlyRows,
    discoveryRows,
    topTrackCounts,
    topArtists,
    topAlbums,
    outgoingFriends,
    incomingFriends,
  ] = await Promise.all([
    db
      .select({
        qualifiedListens: sql<number>`count(*)::int`,
        listeningSeconds: sql<number>`coalesce(sum(${contributedSeconds}), 0)::float8`,
        exactListens: sql<number>`count(${listens.listenedSeconds})::int`,
        estimatedListens: sql<number>`count(*) filter (where ${listens.listenedSeconds} is null and ${tracks.durationSec} is not null)::int`,
        uniqueTracks: sql<number>`count(distinct ${listens.trackId})::int`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(libraryPeriod),
    db
      .select({
        date: dayExpression,
        listens: sql<number>`count(*)::int`,
        listeningSeconds: sql<number>`coalesce(sum(${contributedSeconds}), 0)::float8`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(libraryPeriod)
      // Group/order by the selected column ordinal so the parameterized time
      // zone is emitted only once; separate $N params are not SQL-equivalent.
      .groupBy(sql`1`)
      .orderBy(asc(sql`1`)),
    db
      .select({
        hour: hourExpression,
        listens: sql<number>`count(*)::int`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(libraryPeriod)
      .groupBy(sql`1`)
      .orderBy(asc(sql`1`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(firstListens)
      .where(
        and(
          gte(firstListens.firstPlayedAt, start),
          lte(firstListens.firstPlayedAt, end)
        )
      ),
    db
      .select({
        trackId: listens.trackId,
        listens: sql<number>`count(*)::int`,
        listeningSeconds: sql<number>`coalesce(sum(${contributedSeconds}), 0)::float8`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(and(libraryPeriod, accessible))
      .groupBy(listens.trackId)
      .orderBy(desc(sql`count(*)`), desc(sql`coalesce(sum(${contributedSeconds}), 0)`))
      .limit(TOP_TRACK_LIMIT),
    db
      .select({
        name: tracks.artist,
        listens: sql<number>`count(*)::int`,
        listeningSeconds: sql<number>`coalesce(sum(${contributedSeconds}), 0)::float8`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(and(libraryPeriod, accessible))
      .groupBy(tracks.artist)
      .orderBy(desc(sql`count(*)`), asc(tracks.artist))
      .limit(TOP_GROUP_LIMIT),
    db
      .select({
        name: tracks.album,
        listens: sql<number>`count(*)::int`,
        listeningSeconds: sql<number>`coalesce(sum(${contributedSeconds}), 0)::float8`,
      })
      .from(listens)
      .innerJoin(tracks, eq(tracks.id, listens.trackId))
      .where(and(libraryPeriod, accessible))
      .groupBy(tracks.album)
      .orderBy(desc(sql`count(*)`), asc(tracks.album))
      .limit(TOP_GROUP_LIMIT),
    friendIds.length
      ? db
          .select({
            id: users.id,
            name: users.name,
            listens: sql<number>`count(*)::int`,
          })
          .from(listens)
          .innerJoin(tracks, eq(tracks.id, listens.trackId))
          .innerJoin(users, eq(users.id, tracks.ownerId))
          .where(and(libraryPeriod, inArray(tracks.ownerId, friendIds)))
          .groupBy(users.id)
          .orderBy(desc(sql`count(*)`), asc(users.name))
          .limit(TOP_GROUP_LIMIT)
      : Promise.resolve([]),
    friendIds.length
      ? db
          .select({
            id: users.id,
            name: users.name,
            listens: sql<number>`count(*)::int`,
          })
          .from(listens)
          .innerJoin(tracks, eq(tracks.id, listens.trackId))
          .innerJoin(users, eq(users.id, listens.userId))
          .where(
            and(
              inArray(listens.userId, friendIds),
              isLibraryTrack(),
              gte(listens.playedAt, start),
              lte(listens.playedAt, end),
              eq(tracks.ownerId, userId)
            )
          )
          .groupBy(users.id)
          .orderBy(desc(sql`count(*)`), asc(users.name))
          .limit(TOP_GROUP_LIMIT)
      : Promise.resolve([]),
  ]);

  const rankedIds = topTrackCounts.map((row) => row.trackId);
  const artistNames = topArtists.flatMap((row) => (row.name ? [row.name] : []));
  const albumNames = topAlbums.flatMap((row) => (row.name ? [row.name] : []));
  const [rankedTracks, artistArtRows, albumArtRows] = await Promise.all([
    rankedIds.length
      ? db
          .select({ track: trackDtoColumns, ownerName: users.name })
          .from(tracks)
          .innerJoin(users, eq(users.id, tracks.ownerId))
          .where(and(isLibraryTrack(), inArray(tracks.id, rankedIds)))
      : Promise.resolve([]),
    artistNames.length
      ? db
          .selectDistinctOn([tracks.artist], {
            name: tracks.artist,
            track: trackDtoColumns,
            ownerName: users.name,
          })
          .from(tracks)
          .innerJoin(users, eq(users.id, tracks.ownerId))
          .where(
            and(
              isLibraryTrack(),
              accessible,
              isNotNull(tracks.artS3Key),
              inArray(tracks.artist, artistNames)
            )
          )
          .orderBy(tracks.artist, desc(tracks.createdAt))
      : Promise.resolve([]),
    albumNames.length
      ? db
          .selectDistinctOn([tracks.album], {
            name: tracks.album,
            track: trackDtoColumns,
            ownerName: users.name,
          })
          .from(tracks)
          .innerJoin(users, eq(users.id, tracks.ownerId))
          .where(
            and(
              isLibraryTrack(),
              accessible,
              isNotNull(tracks.artS3Key),
              inArray(tracks.album, albumNames)
            )
          )
          .orderBy(tracks.album, desc(tracks.createdAt))
      : Promise.resolve([]),
  ]);
  const tracksById = new Map(rankedTracks.map((row) => [row.track.id, row]));
  const topTracks = topTrackCounts.flatMap((count) => {
    const row = tracksById.get(count.trackId);
    if (!row) return [];
    return [
      {
        track: toTrackDTO(
          row.track,
          row.track.ownerId === userId ? null : row.ownerName
        ),
        listens: count.listens,
        listeningSeconds: count.listeningSeconds,
      },
    ];
  });
  const toArtMap = (
    rows: Array<{
      name: string | null;
      track: (typeof rankedTracks)[number]["track"];
      ownerName: string;
    }>
  ) =>
    new Map(
      rows.flatMap((row) =>
        row.name
          ? [
              [
                row.name,
                toTrackDTO(
                  row.track,
                  row.track.ownerId === userId ? null : row.ownerName
                ),
              ] as const,
            ]
          : []
      )
    );
  const artistArt = toArtMap(artistArtRows);
  const albumArt = toArtMap(albumArtRows);

  const daily = denseDays(start, end, timeZone, dailyRows);
  const activeDays = daily.filter((day) => day.listens > 0).length;
  const byHour = new Map(hourlyRows.map((row) => [row.hour, row.listens]));
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const count = byHour.get(hour) ?? 0;
    return {
      hour,
      listens: count,
      averagePerActiveDay: activeDays ? count / activeDays : 0,
    };
  });
  const busiest = daily.reduce<StatsDailyActivityDTO | null>(
    (best, day) => (!best || day.listens > best.listens ? day : best),
    null
  );
  const peak = hourly.reduce<(typeof hourly)[number] | null>(
    (best, hour) => (!best || hour.listens > best.listens ? hour : best),
    null
  );
  const totals = totalsRows[0] ?? {
    qualifiedListens: 0,
    listeningSeconds: 0,
    exactListens: 0,
    estimatedListens: 0,
    uniqueTracks: 0,
  };

  return {
    range,
    timeZone,
    period: { start: start.toISOString(), end: end.toISOString() },
    summary: {
      ...totals,
      activeDays,
      newDiscoveries: discoveryRows[0]?.count ?? 0,
      longestStreak: longestStreak(daily),
      busiestDay:
        busiest && busiest.listens > 0
          ? { date: busiest.date, listens: busiest.listens }
          : null,
      peakHour:
        peak && peak.listens > 0
          ? { hour: peak.hour, listens: peak.listens }
          : null,
    },
    daily,
    hourly,
    topTracks,
    topArtists: topArtists.map((entry) => ({
      ...entry,
      artTrack: entry.name ? (artistArt.get(entry.name) ?? null) : null,
    })),
    topAlbums: topAlbums.map((entry) => ({
      ...entry,
      artTrack: entry.name ? (albumArt.get(entry.name) ?? null) : null,
    })),
    outgoingFriends,
    incomingFriends,
  };
}
