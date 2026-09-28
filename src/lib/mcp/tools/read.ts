import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getFriendActivity } from "@/lib/friend-activity";
import { areFriends, friendsOf } from "@/lib/friends";
import { getJob } from "@/lib/import/jobs";
import { findLibraryIssues } from "@/lib/library-issues";
import { listListenHistory, parseListenCursor } from "@/lib/listens";
import { listActions, MAX_ACTIONS_PAGE } from "@/lib/mcp/actions";
import {
  getAccessiblePlaylist,
  getPlaylistWithTracks,
  listAccessiblePlaylists,
  listPlaylistsWithCount,
} from "@/lib/playlists";
import { searchTracks } from "@/lib/search";
import { findPlaylistRecommendations, findSimilarTracks } from "@/lib/similar";
import { getUserStats, isValidTimeZone } from "@/lib/stats";
import { getSuggestedImportPool } from "@/lib/suggested-imports";
import {
  getTrackDetail,
  listAccessibleTracksPage,
  listFriendsTracksPage,
  listOwnTracksPage,
  listTracksByAlbum,
  listTracksByArtist,
  listTracksOfFriend,
  parseTrackCursor,
} from "@/lib/tracks";
import type { LibraryIssueTrackDTO } from "@/lib/types";
import { getDisplayName, getUserSettings } from "@/lib/users";
import { defineTool, fail, ok, READ, uuid, type ToolContext } from "./shared";

const FRIEND_TRACKS_CAP = 200;
const IMPORT_LOG_TAIL = 20;

const scope = z.enum(["own", "friends", "all"]);
const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const sameText = (a: string | null, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const userId = ctx.auth.userId;

  defineTool(
    server,
    "search_library",
    {
      title: "Search library",
      description:
        "Search the user's music library (and their friends' shared tracks) by title, artist, album, or a fragment of the lyrics. Use it to find a song when the user remembers only a line of lyrics. Lyric hits carry `lyricSnippet`, a short excerpt where the matched words are wrapped in « » markers. scope: own = the user's tracks, friends = friends' shared tracks, all = both.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        scope: scope.default("all"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ,
    },
    async ({ query, scope, limit }) => {
      const hits = await searchTracks(userId, query, scope, {
        limit,
        lyricSnippets: true,
      });
      return ok({
        tracks: hits.map((t) => ({ ...ctx.track(t), lyricSnippet: t.lyricSnippet })),
      });
    }
  );

  defineTool(
    server,
    "get_track",
    {
      title: "Get track",
      description:
        "Full details of one track by id, including its lyrics when known.",
      inputSchema: z.object({ trackId: uuid }),
      annotations: READ,
    },
    async ({ trackId }) => {
      const detail = await getTrackDetail(userId, trackId);
      if (!detail) return fail("Track not found");
      return ok({
        track: ctx.track(detail.track),
        lyrics: detail.lyrics,
        lyricsSource: detail.lyricsSource,
      });
    }
  );

  defineTool(
    server,
    "browse_library",
    {
      title: "Browse library",
      description:
        "List tracks newest first, paged with `cursor` (pass the previous page's nextCursor). Optionally filter to one artist and/or album (exact name, case-insensitive); filtered results are sorted by title, not paged, and capped at `limit`. scope: own = the user's tracks, friends = friends' shared tracks, all = both.",
      inputSchema: z.object({
        scope: scope.default("own"),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(256).optional(),
        artist: z.string().trim().min(1).max(200).optional(),
        album: z.string().trim().min(1).max(200).optional(),
      }),
      annotations: READ,
    },
    async ({ scope, limit, cursor, artist, album }) => {
      const { hideFriendDuplicates } = await getUserSettings(userId);
      if (artist !== undefined || album !== undefined) {
        if (cursor !== undefined) {
          return fail("cursor applies only when browsing without artist or album");
        }
        const all =
          album !== undefined
            ? await listTracksByAlbum(userId, album, hideFriendDuplicates)
            : await listTracksByArtist(userId, artist!, hideFriendDuplicates);
        const matching = all.filter(
          (t) =>
            (artist === undefined || sameText(t.artist, artist)) &&
            (scope === "all" ||
              (scope === "own") === (t.ownerId === userId))
        );
        return ok({
          tracks: matching.slice(0, limit).map(ctx.track),
          totalCount: matching.length,
          truncated: matching.length > limit,
        });
      }

      let parsedCursor;
      if (cursor !== undefined) {
        parsedCursor = parseTrackCursor(cursor) ?? undefined;
        if (!parsedCursor) return fail("Invalid cursor");
      }
      const page =
        scope === "own"
          ? await listOwnTracksPage(userId, limit, parsedCursor)
          : scope === "friends"
            ? await listFriendsTracksPage(userId, hideFriendDuplicates, limit, parsedCursor)
            : await listAccessibleTracksPage(userId, hideFriendDuplicates, limit, parsedCursor);
      return ok({
        tracks: page.tracks.map(ctx.track),
        totalCount: page.totalCount,
        nextCursor: page.nextCursor,
      });
    }
  );

  defineTool(
    server,
    "get_similar_tracks",
    {
      title: "Get similar tracks",
      description:
        "Tracks that sound similar to a seed track (audio-embedding similarity with some randomness), from the user's and friends' libraries. Pass already-seen ids in excludeIds to get fresh results. Useful for extending a playlist or a \"more like this\" request.",
      inputSchema: z.object({
        trackId: uuid,
        limit: z.number().int().min(1).max(50).default(20),
        excludeIds: z.array(uuid).max(500).default([]),
      }),
      annotations: READ,
    },
    async ({ trackId, limit, excludeIds }) => {
      const similar = await findSimilarTracks(userId, trackId, { limit, excludeIds });
      return ok({
        tracks: similar.map(ctx.track),
        ...(similar.length === 0 && {
          note: "No results: the track may be inaccessible or not yet analysed.",
        }),
      });
    }
  );

  defineTool(
    server,
    "list_playlists",
    {
      title: "List playlists",
      description:
        "The user's playlists (own plus ones they collaborate on), most recently updated first. With includeFriends, also friends' visible playlists. `canEdit` tells whether the user may change a playlist.",
      inputSchema: z.object({ includeFriends: z.boolean().default(false) }),
      annotations: READ,
    },
    async ({ includeFriends }) => {
      const playlists = includeFriends
        ? await listAccessiblePlaylists(userId)
        : await listPlaylistsWithCount(userId);
      return ok({ playlists: playlists.map(ctx.playlist) });
    }
  );

  defineTool(
    server,
    "get_playlist",
    {
      title: "Get playlist",
      description: "One playlist with its tracks in order.",
      inputSchema: z.object({ playlistId: uuid }),
      annotations: READ,
    },
    async ({ playlistId }) => {
      const playlist = await getPlaylistWithTracks(playlistId, userId);
      if (!playlist) return fail("Playlist not found");
      return ok({
        playlist: ctx.playlist(playlist),
        tracks: playlist.tracks.map(ctx.track),
      });
    }
  );

  defineTool(
    server,
    "get_playlist_recommendations",
    {
      title: "Get playlist recommendations",
      description:
        "Tracks not yet in a playlist that fit its overall sound, drawn from the user's and friends' libraries.",
      inputSchema: z.object({
        playlistId: uuid,
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ,
    },
    async ({ playlistId, limit }) => {
      if (!(await getAccessiblePlaylist(playlistId, userId))) {
        return fail("Playlist not found");
      }
      const tracks = await findPlaylistRecommendations(userId, playlistId, { limit });
      return ok({ tracks: tracks.map(ctx.track) });
    }
  );

  defineTool(
    server,
    "get_listening_stats",
    {
      title: "Get listening stats",
      description:
        "The user's listening statistics for a period: totals, streaks, daily and hourly activity, top tracks, artists and albums, and which friends they listen to most / who listens to them. timeZone is an IANA zone such as Europe/Rome.",
      inputSchema: z.object({
        range: z.enum(["7d", "30d", "90d", "6m", "1y"]).default("30d"),
        timeZone: z.string().trim().min(1).max(100).default("UTC"),
      }),
      annotations: READ,
    },
    async ({ range, timeZone }) => {
      if (!isValidTimeZone(timeZone)) return fail("Invalid time zone");
      const stats = await getUserStats(userId, range, timeZone);
      const ranked = (items: typeof stats.topArtists) =>
        items.map((i) => ({
          name: i.name,
          listens: i.listens,
          listeningSeconds: i.listeningSeconds,
        }));
      return ok({
        ...stats,
        topTracks: stats.topTracks.map((t) => ({
          track: ctx.track(t.track),
          listens: t.listens,
          listeningSeconds: t.listeningSeconds,
        })),
        topArtists: ranked(stats.topArtists),
        topAlbums: ranked(stats.topAlbums),
      });
    }
  );

  defineTool(
    server,
    "get_listening_history",
    {
      title: "Get listening history",
      description:
        "The user's own plays, newest first. from is inclusive and to exclusive (ISO date or date-time). Page with cursor = the previous nextCursor.",
      inputSchema: z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().max(256).optional(),
      }),
      annotations: READ,
    },
    async ({ from, to, limit, cursor }) => {
      let before;
      if (cursor !== undefined) {
        before = parseListenCursor(cursor) ?? undefined;
        if (!before) return fail("Invalid cursor");
      }
      const history = await listListenHistory(userId, {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit,
        before,
      });
      return ok({
        items: history.items.map((i) => ({
          track: ctx.track(i.track),
          playedAt: i.playedAt,
          listenedSeconds: i.listenedSeconds,
        })),
        nextCursor: history.nextBefore,
      });
    }
  );

  defineTool(
    server,
    "list_friends",
    {
      title: "List friends",
      description:
        "The user's friends, with how many times friends have listened to each friend's library.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const friends = await friendsOf(userId);
      return ok({
        friends: friends.map((f) => ({
          id: f.id,
          name: f.name,
          friendListens: f.friendListens ?? 0,
          link: `${ctx.base}/discover/${f.id}`,
        })),
      });
    }
  );

  defineTool(
    server,
    "get_friend_activity",
    {
      title: "Get friend activity",
      description:
        "What the user's friends recently added to their libraries and what each friend played most (aggregate play counts only) in the last `days` days.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(30).default(7),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: READ,
    },
    async ({ days, limit }) => {
      const activity = await getFriendActivity(userId, { days, limit });
      return ok({
        recentlyAdded: activity.recentlyAdded.map(ctx.track),
        topPlayed: activity.topPlayed.map((f) => ({
          friend: f.friend,
          tracks: f.tracks.map((t) => ({ track: ctx.track(t.track), plays: t.plays })),
        })),
      });
    }
  );

  defineTool(
    server,
    "get_friend_tracks",
    {
      title: "Get friend tracks",
      description: `One friend's shared tracks, newest first (at most ${FRIEND_TRACKS_CAP}). Get friend ids from list_friends.`,
      inputSchema: z.object({ friendId: uuid }),
      annotations: READ,
    },
    async ({ friendId }) => {
      if (!(await areFriends(userId, friendId))) {
        return fail("Forbidden: not one of your friends");
      }
      const tracks = await listTracksOfFriend(friendId, await getDisplayName(friendId));
      return ok({
        tracks: tracks.slice(0, FRIEND_TRACKS_CAP).map(ctx.track),
        totalCount: tracks.length,
        ...(tracks.length > FRIEND_TRACKS_CAP && {
          note: `Showing the newest ${FRIEND_TRACKS_CAP} of ${tracks.length} tracks.`,
        }),
        link: `${ctx.base}/discover/${friendId}`,
      });
    }
  );

  const issueTrack = (i: LibraryIssueTrackDTO) => ({
    track: ctx.track(i.track),
    estimatedKbps: i.estimatedKbps,
    playlistCount: i.playlistCount,
  });

  defineTool(
    server,
    "find_library_issues",
    {
      title: "Find library issues",
      description:
        "Find problems in the user's own library: tracks missing an artist, album or cover art, tracks with an estimated bitrate below minKbps (default 128; the estimate includes embedded art, so it runs high), or possible duplicates (same title and artist; results are groups, and playlistCount helps pick the copy to keep). Metadata can be fixed with update_tracks_metadata. This tool cannot delete tracks: the user deletes duplicates in the WebTunes web app, using each result's link. Page with offset.",
      inputSchema: z.object({
        kind: z.enum([
          "missing_artist",
          "missing_album",
          "missing_art",
          "low_bitrate",
          "possible_duplicates",
        ]),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(100_000).default(0),
        minKbps: z.number().int().min(1).max(10_000).optional(),
      }),
      annotations: READ,
    },
    async ({ kind, limit, offset, minKbps }) => {
      const issues = await findLibraryIssues(userId, kind, { limit, offset, minKbps });
      if (issues.kind === "possible_duplicates") {
        return ok({
          kind: issues.kind,
          totalGroups: issues.total,
          groups: issues.items.map((g) => g.tracks.map(issueTrack)),
        });
      }
      return ok({
        kind: issues.kind,
        total: issues.total,
        items: issues.items.map(issueTrack),
      });
    }
  );

  defineTool(
    server,
    "list_suggested_imports",
    {
      title: "List suggested imports",
      description:
        "Songs WebTunes downloaded as suggestions based on the user's taste, waiting for the user to keep (accept_suggested_imports) or discard (reject_suggested_imports). Each has a reason it was suggested.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const pool = await getSuggestedImportPool(userId);
      return ok({
        suggestions: pool.items.map((s) => ({
          suggestionId: s.id,
          title: s.track.title,
          artist: s.track.artist,
          album: s.track.album,
          durationSec: s.track.durationSec,
          reason: s.reason,
        })),
        target: pool.target,
        processing: pool.processing,
        blockedReason: pool.blockedReason,
        link: `${ctx.base}/discover`,
      });
    }
  );

  defineTool(
    server,
    "get_import_status",
    {
      title: "Get import status",
      description:
        "Progress of an import started with start_import: overall status and per-item results. Poll every few seconds until status is done, cancelled or error. For items with status missed, try search_youtube and start_import with a single video URL. Jobs are forgotten an hour after they finish.",
      inputSchema: z.object({ jobId: uuid }),
      annotations: READ,
    },
    async ({ jobId }) => {
      const job = getJob(userId, jobId);
      if (!job) return fail("Import job not found");
      const counts: Record<string, number> = {};
      for (const item of job.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
      return ok({
        jobId: job.id,
        sourceUrl: job.sourceUrl,
        kind: job.kind,
        status: job.status,
        error: job.error,
        counts,
        items: job.items,
        recentLog: job.log.slice(-IMPORT_LOG_TAIL),
        startedAt: job.createdAt,
        finishedAt: job.finishedAt,
      });
    }
  );

  defineTool(
    server,
    "list_actions",
    {
      title: "List actions",
      description:
        "The undo log: changes made through connected apps like this one, newest first, with whether each can still be undone (undo_action). Page with cursor = the previous nextCursor.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(MAX_ACTIONS_PAGE).default(20),
        cursor: uuid.optional(),
      }),
      annotations: READ,
    },
    async ({ limit, cursor }) => {
      const page = await listActions(userId, { limit, before: cursor });
      return ok({ ...page });
    }
  );
}
