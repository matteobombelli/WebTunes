"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  StatsDTO,
  StatsRange,
  StatsRankedFriendDTO,
  StatsRankedNameDTO,
} from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import TrackArt from "@/components/TrackArt";
import { MusicIcon, PlayIcon } from "@/components/icons";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const RANGE_OPTIONS: ReadonlyArray<{ value: StatsRange; label: string }> = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
];

const CARD = "rounded-xl border border-border-subtle bg-surface-1";
const GRAPH_CARD = "rounded-xl border border-border bg-black/45";

function formatTime(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? "<1m" : "0m";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.round(seconds / 360) / 10;
  if (hours < 24) return `${hours.toLocaleString()}h`;
  let days = Math.floor(hours / 24);
  let remainder = Math.round(hours - days * 24);
  if (remainder === 24) {
    days += 1;
    remainder = 0;
  }
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
}

function formatDate(date: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options ?? { month: "short", day: "numeric" }).format(
    new Date(`${date}T12:00:00`)
  );
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(
    new Date(2020, 0, 1, hour)
  );
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={`${CARD} min-w-0 p-4`} title={hint}>
      <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
        {label}
      </p>
      <p className="mt-1 truncate font-display text-2xl font-semibold text-fg">
        {value}
      </p>
      {hint && <p className="mt-1 line-clamp-2 text-[11px] text-fg-muted">{hint}</p>}
    </div>
  );
}

function ActivityHeatmap({ stats }: { stats: StatsDTO }) {
  const max = Math.max(1, ...stats.daily.map((day) => day.listens));
  const firstWeekday = new Date(`${stats.daily[0]?.date ?? "1970-01-04"}T12:00:00`).getDay();
  const levelClass = (listens: number) => {
    if (listens === 0) return "bg-surface-3";
    const ratio = listens / max;
    if (ratio <= 0.25) return "bg-accent/30";
    if (ratio <= 0.5) return "bg-accent/50";
    if (ratio <= 0.75) return "bg-accent/75";
    return "bg-accent";
  };

  return (
    <section className={`${GRAPH_CARD} p-4 sm:p-5`}>
      <div className="mb-4">
        <h2 className="font-display text-lg font-semibold">Daily activity</h2>
        <p className="text-xs text-fg-muted">Each square is one local calendar day.</p>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="grid w-max grid-flow-col grid-rows-7 gap-1">
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="h-3 w-3" aria-hidden />
          ))}
          {stats.daily.map((day) => {
            const label = `${formatDate(day.date, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })}: ${day.listens} ${day.listens === 1 ? "listen" : "listens"}, ${formatTime(day.listeningSeconds)} listening time`;
            return (
              <span
                key={day.date}
                role="img"
                tabIndex={0}
                aria-label={label}
                title={label}
                className={`h-3 w-3 rounded-[3px] outline-none ring-accent focus-visible:ring-2 ${levelClass(day.listens)}`}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-fg-subtle">
        <span className="mr-1">Less</span>
        {["bg-surface-3", "bg-accent/30", "bg-accent/50", "bg-accent/75", "bg-accent"].map(
          (color) => <span key={color} className={`h-3 w-3 rounded-[3px] ${color}`} />
        )}
        <span className="ml-1">More</span>
      </div>
    </section>
  );
}

function HourlyChart({ stats }: { stats: StatsDTO }) {
  const max = Math.max(0.01, ...stats.hourly.map((hour) => hour.averagePerActiveDay));
  return (
    <section className={`${GRAPH_CARD} p-4 sm:p-5`}>
      <div className="mb-4">
        <h2 className="font-display text-lg font-semibold">Listening by time of day</h2>
        <p className="text-xs text-fg-muted">Average qualified listens per active day.</p>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="grid h-44 min-w-[42rem] grid-cols-[repeat(24,minmax(0,1fr))] items-end gap-1.5 border-b border-border-subtle px-1">
          {stats.hourly.map((hour) => {
            const height = hour.listens ? Math.max(4, (hour.averagePerActiveDay / max) * 100) : 0;
            const label = `${formatHour(hour.hour)}: ${hour.averagePerActiveDay.toFixed(1)} average, ${hour.listens} total`;
            return (
              <div key={hour.hour} className="flex h-full min-w-0 flex-col justify-end gap-1">
                <div className="flex min-h-0 flex-1 items-end">
                  <span
                    role="img"
                    tabIndex={0}
                    aria-label={label}
                    title={label}
                    className="block w-full rounded-t bg-gradient-to-t from-accent to-accent-bright outline-none ring-accent focus-visible:ring-2"
                    style={{ height: `${height}%` }}
                  />
                </div>
                <span className="h-4 text-center text-[9px] text-fg-subtle">
                  {hour.hour % 3 === 0 ? formatHour(hour.hour).replace(" ", "") : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TrackRanking({ stats }: { stats: StatsDTO }) {
  const current = useCurrentTrack();
  const tracks = useMemo(() => stats.topTracks.map((entry) => entry.track), [stats.topTracks]);
  if (!stats.topTracks.length) return <EmptyRanking title="Top tracks" />;

  return (
    <section className={`${CARD} overflow-hidden`}>
      <h2 className="px-4 pb-2 pt-4 font-display text-lg font-semibold">Top tracks</h2>
      <ol>
        {stats.topTracks.map((entry, index) => (
          <li
            key={entry.track.id}
            className={`${index >= 10 ? "hidden lg:grid" : "grid"} grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border-subtle px-3 py-2 ${
              current?.id === entry.track.id ? "bg-accent/10" : "hover:bg-surface-2/50"
            }`}
          >
            <span className="text-center text-xs tabular-nums text-fg-subtle">{index + 1}</span>
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() =>
                  usePlayerStore.getState().playQueue(tracks, index, { collection: true })
                }
                title={`Play ${entry.track.title}`}
                className="group flex min-w-0 items-center gap-2 text-left"
              >
                <span className="relative shrink-0">
                  <TrackArt track={entry.track} size="h-10 w-10" iconSize={18} thumb />
                  <span className="absolute inset-0 hidden items-center justify-center rounded bg-black/50 text-white group-hover:flex group-focus-visible:flex">
                    <PlayIcon size={18} />
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium group-hover:text-accent-bright">
                    {entry.track.title}
                  </span>
                  <span className="block truncate text-xs text-fg-muted sm:hidden">
                    {entry.track.artist ?? "Unknown artist"}
                  </span>
                </span>
              </button>
              {entry.track.artist && (
                <Link
                  href={`/artist?name=${encodeURIComponent(entry.track.artist)}`}
                  className="hidden min-w-0 truncate text-xs text-fg-muted hover:text-accent-bright sm:block"
                >
                  {entry.track.artist}
                </Link>
              )}
            </div>
            <span className="text-right text-xs tabular-nums text-fg-muted">
              {entry.listens}×
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EmptyRanking({ title }: { title: string }) {
  return (
    <section className={`${CARD} p-4`}>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-fg-muted">No listening activity yet.</p>
    </section>
  );
}

function NameRanking({
  title,
  kind,
  entries,
}: {
  title: string;
  kind: "artist" | "album";
  entries: StatsRankedNameDTO[];
}) {
  if (!entries.length) return <EmptyRanking title={title} />;
  return (
    <section className={`${CARD} overflow-hidden`}>
      <h2 className="px-4 pb-2 pt-4 font-display text-lg font-semibold">{title}</h2>
      <ol>
        {entries.map((entry, index) => {
          const label = entry.name ?? `Unknown ${kind}`;
          return (
            <li
              key={entry.name ?? `unknown-${kind}`}
              className="grid grid-cols-[1.5rem_2.5rem_minmax(0,1fr)_auto] items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm hover:bg-surface-2/50"
            >
              <span className="text-center text-xs tabular-nums text-fg-subtle">{index + 1}</span>
              {entry.artTrack ? (
                <TrackArt
                  track={entry.artTrack}
                  size="h-10 w-10"
                  iconSize={18}
                  thumb
                />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded bg-surface-2 text-fg-subtle">
                  <MusicIcon size={18} />
                </span>
              )}
              {entry.name ? (
                <Link
                  href={`/${kind}?name=${encodeURIComponent(entry.name)}`}
                  className="truncate font-medium hover:text-accent-bright"
                >
                  {label}
                </Link>
              ) : (
                <span className="truncate text-fg-muted">{label}</span>
              )}
              <span className="text-right text-xs tabular-nums text-fg-muted">{entry.listens}×</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function FriendRanking({ title, entries }: { title: string; entries: StatsRankedFriendDTO[] }) {
  if (!entries.length) return <EmptyRanking title={title} />;
  return (
    <section className={`${CARD} overflow-hidden`}>
      <h2 className="px-4 pb-2 pt-4 font-display text-lg font-semibold">{title}</h2>
      <ol>
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-2 border-t border-border-subtle px-3 py-2.5 text-sm hover:bg-surface-2/50"
          >
            <span className="text-center text-xs tabular-nums text-fg-subtle">{index + 1}</span>
            <Link
              href={`/discover/${entry.id}`}
              className="truncate font-medium hover:text-accent-bright"
            >
              {entry.name}
            </Link>
            <span className="text-right text-xs tabular-nums text-fg-muted">{entry.listens}×</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StatsContent({ stats }: { stats: StatsDTO }) {
  const { summary } = stats;
  const unmeasured =
    summary.qualifiedListens - summary.exactListens - summary.estimatedListens;
  const coverageHint = [
    summary.exactListens
      ? `${summary.exactListens.toLocaleString()} exact`
      : null,
    summary.estimatedListens
      ? `${summary.estimatedListens.toLocaleString()} legacy estimated`
      : null,
    unmeasured ? `${unmeasured.toLocaleString()} without duration` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {summary.qualifiedListens === 0 && (
        <div className={`${CARD} p-4 text-sm text-fg-muted`}>
          Play a track for at least 30 seconds to start building your listening history.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Listening time" value={formatTime(summary.listeningSeconds)} hint={coverageHint} />
        <SummaryCard label="Qualified listens" value={summary.qualifiedListens.toLocaleString()} hint="A listen is recorded after 30 seconds." />
        <SummaryCard label="Active days" value={summary.activeDays.toLocaleString()} />
        <SummaryCard label="Unique tracks" value={summary.uniqueTracks.toLocaleString()} />
        <SummaryCard label="New discoveries" value={summary.newDiscoveries.toLocaleString()} hint="Tracks first heard during this period." />
        <SummaryCard label="Longest streak" value={`${summary.longestStreak}d`} />
        <SummaryCard
          label="Busiest day"
          value={summary.busiestDay ? formatDate(summary.busiestDay.date) : "-"}
          hint={summary.busiestDay ? `${summary.busiestDay.listens} listens` : undefined}
        />
        <SummaryCard
          label="Peak hour"
          value={summary.peakHour ? formatHour(summary.peakHour.hour) : "-"}
          hint={summary.peakHour ? `${summary.peakHour.listens} listens` : undefined}
        />
      </div>

      <ActivityHeatmap stats={stats} />
      <HourlyChart stats={stats} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TrackRanking stats={stats} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <NameRanking title="Top artists" kind="artist" entries={stats.topArtists} />
          <NameRanking title="Top albums" kind="album" entries={stats.topAlbums} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FriendRanking title="Friends you listened to" entries={stats.outgoingFriends} />
        <FriendRanking title="Friends who listened to you" entries={stats.incomingFriends} />
      </div>
    </div>
  );
}

export default function StatsPanel({ active }: { active: boolean }) {
  const [range, setRange] = useState<StatsRange>("30d");
  // The value is only used after mount by the fetch effect and does not affect
  // the server-rendered shell, so a lazy browser lookup is hydration-safe.
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [cache, setCache] = useState<Partial<Record<StatsRange, StatsDTO>>>({});
  const [error, setError] = useState<{ range: StatsRange; message: string } | null>(null);

  useEffect(() => {
    if (
      !active ||
      !timeZone ||
      cache[range] ||
      error?.range === range
    ) {
      return;
    }
    const controller = new AbortController();
    api<StatsDTO>(`/stats?range=${range}&tz=${encodeURIComponent(timeZone)}`, {
      signal: controller.signal,
    })
      .then((stats) => setCache((current) => ({ ...current, [range]: stats })))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError({
            range,
            message: cause instanceof Error ? cause.message : "Couldn’t load stats",
          });
        }
      });
    return () => controller.abort();
  }, [active, cache, error, range, timeZone]);

  const stats = cache[range];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end overflow-x-auto pb-1">
        <SegmentedControl options={RANGE_OPTIONS} value={range} onChange={setRange} />
      </div>
      {error?.range === range ? (
        <div className={`${CARD} flex flex-col items-center gap-3 p-8 text-center`}>
          <p className="text-sm text-red-300">{error.message}</p>
          <button
            onClick={() => setError(null)}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
          >
            Retry
          </button>
        </div>
      ) : stats ? (
        <StatsContent stats={stats} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Loading stats">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className={`${CARD} h-24 animate-pulse bg-surface-2`} />
          ))}
        </div>
      )}
    </div>
  );
}
