import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "@/db";
import { DEMO_READ_ONLY_MESSAGE, isDemoAccount } from "@/lib/demo-accounts";
import { cancelJob, startImport } from "@/lib/import/jobs";
import { flatExtract } from "@/lib/import/ytdlp";
import { log } from "@/lib/log";
import {
  appendImportedTrack,
  recordAction,
  undoAction,
} from "@/lib/mcp/actions";
import {
  addPlaylistTracks,
  createPlaylist,
  getPlaylistTrackIds,
  lockEditablePlaylist,
  removePlaylistTracks,
  reorderPlaylistTracks,
  updatePlaylist,
} from "@/lib/playlists";
import { deleteObjectsBestEffort } from "@/lib/s3";
import { createOrGetShare } from "@/lib/shares";
import {
  acceptSuggestedImport,
  rejectSuggestedImport,
  wakeSuggestedImportWorker,
} from "@/lib/suggested-imports";
import {
  deleteOwnedTrack,
  loadAccessibleTrack,
  trackMetadataPatchSchema,
  updateTrackMetadata,
  type OwnedTrackResult,
  type TrackMetadataFields,
} from "@/lib/tracks";
import { DEFAULT_IMPORT_OPTIONS } from "@/lib/types";
import {
  defineTool,
  fail,
  ok,
  ToolError,
  UNDO_NOTE,
  uuid,
  WRITE,
  type ToolContext,
} from "./shared";

// Same as GET /api/import/search.
const YOUTUBE_SEARCH_RESULTS = 25;
const YOUTUBE_SEARCH_TIMEOUT_MS = 60_000;

const PLAYLIST_ADD_ERRORS = {
  not_found: "Playlist not found",
  track_not_found: "Track not found",
  forbidden: "Forbidden: a track is not accessible to you",
  already_present: "Already in playlist",
} as const;

const OWNED_TRACK_ERRORS: Record<Exclude<OwnedTrackResult["status"], "ok">, string> = {
  not_found: "Track not found",
  forbidden: "Forbidden: you can only edit your own tracks",
  suggested_import: "Use Suggested Imports to accept or reject this track",
};

const TRACK_FIELDS = ["title", "artist", "album", "isPrivate"] as const;

const unique = (ids: string[]) => [...new Set(ids)];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const trackIdList = (max: number) => z.array(uuid).min(1).max(max);
const suggestionIdList = z.array(uuid).min(1).max(20);

type Recorded = { id: string; undoableUntil: Date };

const undoInfo = (r: Recorded) => ({
  actionId: r.id,
  undoableUntil: r.undoableUntil.toISOString(),
});

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  const { userId, grantId, clientName, email } = ctx.auth;
  const actor = { userId, grantId, clientName };
  const isDemo = isDemoAccount(email);

  defineTool(
    server,
    "create_playlist",
    {
      title: "Create playlist",
      description: `Create a playlist owned by the user, optionally private and optionally filled with tracks (in the given order). Fails without creating anything if any track is missing or inaccessible. ${UNDO_NOTE}`,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(100),
        isPrivate: z.boolean().optional(),
        trackIds: z.array(uuid).max(500).optional(),
      }),
      annotations: { ...WRITE, idempotentHint: false },
    },
    async ({ name, isPrivate, trackIds = [] }) => {
      const ids = unique(trackIds);
      const result = await db.transaction(async (tx) => {
        const playlist = await createPlaylist(userId, name, tx);
        if (isPrivate) await updatePlaylist(playlist.id, userId, { isPrivate }, tx);
        let added: string[] = [];
        if (ids.length) {
          const add = await addPlaylistTracks(playlist.id, userId, ids, tx);
          if (add.status !== "ok") throw new ToolError(PLAYLIST_ADD_ERRORS[add.status]);
          added = add.added;
        }
        const recorded = await recordAction(tx, {
          ...actor,
          summary: `Created playlist "${name}" with ${plural(added.length, "track")}`,
          kind: "playlist.create",
          payload: {
            playlistId: playlist.id,
            name,
            trackIds: added,
            isPrivate: isPrivate ?? false,
          },
        });
        return { playlist, added, recorded };
      });
      return ok({
        playlistId: result.playlist.id,
        name,
        isPrivate: Boolean(isPrivate),
        tracksAdded: result.added.length,
        link: ctx.playlistLink(result.playlist.id),
        ...undoInfo(result.recorded),
      });
    }
  );

  defineTool(
    server,
    "update_playlist",
    {
      title: "Update playlist",
      description: `Rename a playlist the user can edit, or change whether it is private (owner only; private playlists are hidden from friends). ${UNDO_NOTE}`,
      inputSchema: z.object({
        playlistId: uuid,
        name: z.string().trim().min(1).max(100).optional(),
        isPrivate: z.boolean().optional(),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ playlistId, name, isPrivate }) => {
      if (name === undefined && isPrivate === undefined) return fail("Nothing to update");
      return db.transaction(async (tx): Promise<CallToolResult> => {
        const current = await lockEditablePlaylist(tx, playlistId, userId);
        if (!current) return fail("Playlist not found");
        const before: { name?: string; isPrivate?: boolean } = {};
        const after: { name?: string; isPrivate?: boolean } = {};
        if (name !== undefined && name !== current.name) {
          before.name = current.name;
          after.name = name;
        }
        if (isPrivate !== undefined && isPrivate !== current.isPrivate) {
          before.isPrivate = current.isPrivate;
          after.isPrivate = isPrivate;
        }
        const link = ctx.playlistLink(playlistId);
        if (Object.keys(after).length === 0) {
          return ok({ changed: false, name: current.name, isPrivate: current.isPrivate, link });
        }
        const result = await updatePlaylist(playlistId, userId, after, tx);
        if (result.status === "not_found") return fail("Playlist not found");
        if (result.status === "forbidden") return fail("Only the owner can change privacy");
        const changes = [
          after.name !== undefined && `renamed to "${after.name}"`,
          after.isPrivate !== undefined &&
            (after.isPrivate ? "made private" : "made visible to friends"),
        ].filter(Boolean);
        const recorded = await recordAction(tx, {
          ...actor,
          summary: `Playlist "${current.name}" ${changes.join(" and ")}`,
          kind: "playlist.update",
          payload: { playlistId, playlistName: result.playlist.name, before, after },
        });
        return ok({
          changed: true,
          name: result.playlist.name,
          isPrivate: result.playlist.isPrivate,
          link,
          ...undoInfo(recorded),
        });
      });
    }
  );

  defineTool(
    server,
    "add_playlist_tracks",
    {
      title: "Add tracks to playlist",
      description: `Append tracks to the end of a playlist the user can edit, in the given order. Tracks already in the playlist are skipped; if all of them are, nothing changes and nothing is recorded. Fails if any track is missing or inaccessible. ${UNDO_NOTE}`,
      inputSchema: z.object({ playlistId: uuid, trackIds: trackIdList(500) }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ playlistId, trackIds }) =>
      db.transaction(async (tx): Promise<CallToolResult> => {
        const playlist = await lockEditablePlaylist(tx, playlistId, userId);
        if (!playlist) return fail("Playlist not found");
        const ids = unique(trackIds);
        const result = await addPlaylistTracks(playlistId, userId, ids, tx);
        const link = ctx.playlistLink(playlistId);
        if (result.status === "already_present") {
          return ok({ added: 0, skippedAlreadyPresent: ids.length, link });
        }
        if (result.status !== "ok") return fail(PLAYLIST_ADD_ERRORS[result.status]);
        const recorded = await recordAction(tx, {
          ...actor,
          summary: `Added ${plural(result.added.length, "track")} to "${playlist.name}"`,
          kind: "playlist.add_tracks",
          payload: { playlistId, playlistName: playlist.name, trackIds: result.added },
        });
        return ok({
          added: result.added.length,
          skippedAlreadyPresent: ids.length - result.added.length,
          link,
          ...undoInfo(recorded),
        });
      })
  );

  defineTool(
    server,
    "remove_playlist_tracks",
    {
      title: "Remove tracks from playlist",
      description: `Remove tracks from a playlist the user can edit. The tracks stay in the library; ids not in the playlist are ignored. ${UNDO_NOTE}`,
      inputSchema: z.object({ playlistId: uuid, trackIds: trackIdList(500) }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ playlistId, trackIds }) =>
      db.transaction(async (tx): Promise<CallToolResult> => {
        const playlist = await lockEditablePlaylist(tx, playlistId, userId);
        if (!playlist) return fail("Playlist not found");
        const result = await removePlaylistTracks(playlistId, userId, trackIds, tx);
        if (result.status !== "ok") return fail("Playlist not found");
        const link = ctx.playlistLink(playlistId);
        if (result.removed.length === 0) return ok({ removed: 0, link });
        const recorded = await recordAction(tx, {
          ...actor,
          summary: `Removed ${plural(result.removed.length, "track")} from "${playlist.name}"`,
          kind: "playlist.remove_tracks",
          payload: { playlistId, playlistName: playlist.name, removed: result.removed },
        });
        return ok({ removed: result.removed.length, link, ...undoInfo(recorded) });
      })
  );

  defineTool(
    server,
    "reorder_playlist",
    {
      title: "Reorder playlist",
      description: `Set the order of a playlist the user can edit. trackIds must list every track currently in the playlist exactly once, in the new order (get them with get_playlist). ${UNDO_NOTE}`,
      inputSchema: z.object({ playlistId: uuid, trackIds: trackIdList(10_000) }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ playlistId, trackIds }) =>
      db.transaction(async (tx): Promise<CallToolResult> => {
        const playlist = await lockEditablePlaylist(tx, playlistId, userId);
        if (!playlist) return fail("Playlist not found");
        const link = ctx.playlistLink(playlistId);
        const current = await getPlaylistTrackIds(playlistId, tx);
        if (
          current.length === trackIds.length &&
          current.every((id, i) => id === trackIds[i])
        ) {
          return ok({ changed: false, link });
        }
        const result = await reorderPlaylistTracks(playlistId, userId, trackIds, tx);
        if (result.status === "not_found") return fail("Playlist not found");
        if (result.status === "invalid") {
          return fail("trackIds must be exactly the playlist's current tracks");
        }
        const recorded = await recordAction(tx, {
          ...actor,
          summary: `Reordered "${playlist.name}"`,
          kind: "playlist.reorder",
          payload: {
            playlistId,
            playlistName: playlist.name,
            before: result.before,
            after: trackIds,
          },
        });
        return ok({ changed: true, link, ...undoInfo(recorded) });
      })
  );

  defineTool(
    server,
    "update_tracks_metadata",
    {
      title: "Update track metadata",
      description: `Edit the title, artist, album or privacy of the user's own tracks (friends' tracks cannot be edited). An empty artist or album clears it. All updates apply together or not at all. ${UNDO_NOTE}`,
      inputSchema: z.object({
        updates: z
          .array(trackMetadataPatchSchema.extend({ trackId: uuid }))
          .min(1)
          .max(200)
          .refine(
            (u) => new Set(u.map((x) => x.trackId)).size === u.length,
            "Each track may appear only once"
          ),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ updates }) => {
      const result = await db.transaction(async (tx) => {
        const items = [];
        for (const { trackId, ...fields } of updates) {
          if (Object.keys(fields).length === 0) {
            throw new ToolError(`Nothing to update for track ${trackId}`);
          }
          const updated = await updateTrackMetadata(userId, trackId, fields, tx);
          if (updated.status !== "ok") {
            throw new ToolError(`${OWNED_TRACK_ERRORS[updated.status]} (track ${trackId})`);
          }
          const before: TrackMetadataFields = {};
          const after: TrackMetadataFields = {};
          for (const field of TRACK_FIELDS) {
            if (updated.before[field] !== updated.track[field]) {
              Object.assign(before, { [field]: updated.before[field] });
              Object.assign(after, { [field]: updated.track[field] });
            }
          }
          if (Object.keys(after).length) {
            items.push({ trackId, title: updated.track.title, before, after });
          }
        }
        if (items.length === 0) return null;
        const recorded = await recordAction(tx, {
          ...actor,
          summary:
            items.length === 1
              ? `Updated metadata of "${items[0].title}"`
              : `Updated metadata of ${items.length} tracks`,
          kind: "track.update_metadata",
          payload: {
            items: items.map(({ trackId, before, after }) => ({ trackId, before, after })),
          },
        });
        return { items, recorded };
      });
      if (!result) return ok({ changed: 0 });
      return ok({
        changed: result.items.length,
        tracks: result.items.map(({ trackId, after }) => ({ trackId, ...after })),
        ...undoInfo(result.recorded),
      });
    }
  );

  defineTool(
    server,
    "search_youtube",
    {
      title: "Search YouTube",
      description:
        "Search YouTube for videos to import, e.g. to find a song an import missed. Returns watch URLs to pass to start_import. Nothing is downloaded or recorded.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(200) }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      if (isDemo) return fail(DEMO_READ_ONLY_MESSAGE);
      let results;
      try {
        results = await flatExtract(
          `ytsearch${YOUTUBE_SEARCH_RESULTS}:${query}`,
          AbortSignal.timeout(YOUTUBE_SEARCH_TIMEOUT_MS)
        );
      } catch {
        return fail("YouTube search failed");
      }
      return ok({
        results: results.map((r) => ({
          title: r.title,
          uploader: r.uploader,
          durationSec: r.duration,
          url: r.url,
        })),
      });
    }
  );

  defineTool(
    server,
    "start_import",
    {
      title: "Start import",
      description: `Import music into the user's library from a YouTube video or playlist URL, or a Spotify / Apple Music track, album or playlist URL (matched to YouTube). Runs in the background: poll get_import_status with the returned jobId. quality: opus (default, best), m4a, 192 or 128 (MP3 kbps). strictness (0-1, default ${DEFAULT_IMPORT_OPTIONS.strictness}) is how closely a YouTube match must fit Spotify/Apple metadata; versionPref prefers studio or live versions. Songs already in the library are skipped. Undo deletes the imported tracks that are not in a playlist, not shared and not edited since. ${UNDO_NOTE}`,
      inputSchema: z.object({
        url: z.string().trim().min(1).max(2000),
        quality: z
          .enum(["128", "192", "opus", "m4a"])
          .default(DEFAULT_IMPORT_OPTIONS.quality),
        strictness: z.number().min(0).max(1).default(DEFAULT_IMPORT_OPTIONS.strictness),
        versionPref: z
          .enum(["none", "studio", "live"])
          .default(DEFAULT_IMPORT_OPTIONS.versionPref),
      }),
      annotations: { ...WRITE, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, quality, strictness, versionPref }) => {
      if (isDemo) return fail(DEMO_READ_ONLY_MESSAGE);

      // The job may create tracks before the action row exists; those ids wait
      // here and are attached once it does. A track the undo log cannot see is
      // deleted, so every MCP-imported track stays undoable.
      let actionId: string | null = null;
      let recordFailed = false;
      const pending: string[] = [];
      const discard = async (trackId: string) => {
        const deleted = await deleteOwnedTrack(userId, trackId);
        if (deleted.status === "ok") await deleteObjectsBestEffort(deleted.objectKeys);
      };
      const attach = async (trackId: string) => {
        let attached = false;
        try {
          // False when the action was already undone.
          attached = await appendImportedTrack(actionId!, trackId);
        } catch (err) {
          log.warn(
            "mcp",
            "start_import could not record an imported track",
            err instanceof Error ? err.constructor.name : typeof err
          );
        }
        if (!attached) await discard(trackId);
      };

      const started = startImport(
        userId,
        url,
        { quality, strictness, versionPref },
        {
          onTrackCreated: (trackId) => {
            if (recordFailed) return discard(trackId);
            if (actionId === null) pending.push(trackId);
            else return attach(trackId);
          },
        }
      );
      if (!started.ok) return fail(started.error);

      let recorded: Recorded;
      try {
        recorded = await db.transaction((tx) =>
          recordAction(tx, {
            ...actor,
            summary: `Started import of ${url.length > 120 ? `${url.slice(0, 117)}...` : url}`,
            kind: "import.start",
            payload: { jobId: started.jobId, url, createdTrackIds: [], createdTracks: [] },
          })
        );
      } catch (err) {
        // Never leave an import running, or its tracks, where the undo log cannot see them.
        recordFailed = true;
        cancelJob(userId, started.jobId);
        for (const trackId of pending.splice(0)) await discard(trackId);
        throw err;
      }
      actionId = recorded.id;
      for (const trackId of pending.splice(0)) await attach(trackId);

      return ok({
        jobId: started.jobId,
        hint: "Poll get_import_status with this jobId every few seconds until it finishes. For missed items, use search_youtube and start_import with a single video URL.",
        ...undoInfo(recorded),
      });
    }
  );

  defineTool(
    server,
    "accept_suggested_imports",
    {
      title: "Accept suggested imports",
      description: `Keep suggested imports (from list_suggested_imports): each becomes a normal track in the user's library. Each id is handled separately; the result reports each one. ${UNDO_NOTE}`,
      inputSchema: z.object({ suggestionIds: suggestionIdList }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ suggestionIds }) => {
      const results = [];
      for (const suggestionId of unique(suggestionIds)) {
        const outcome = await db.transaction(async (tx) => {
          const accepted = await acceptSuggestedImport(userId, suggestionId, tx);
          if (accepted.status !== "ok") return accepted;
          const recorded = await recordAction(tx, {
            ...actor,
            summary: `Accepted suggested import "${accepted.track.title}"`,
            kind: "suggestion.accept",
            payload: {
              suggestionId,
              trackId: accepted.trackId,
              previousCreatedAt: accepted.previousCreatedAt.toISOString(),
            },
          });
          return { ...accepted, recorded };
        });
        results.push(
          outcome.status === "ok"
            ? {
                suggestionId,
                status: "accepted",
                track: ctx.track(outcome.track),
                ...undoInfo(outcome.recorded),
              }
            : {
                suggestionId,
                status: "failed",
                error:
                  outcome.status === "not_found"
                    ? "Suggestion not found"
                    : "Suggestion is no longer ready",
              }
        );
      }
      if (results.some((r) => r.status === "accepted")) wakeSuggestedImportWorker();
      return ok({ results });
    }
  );

  defineTool(
    server,
    "reject_suggested_imports",
    {
      title: "Reject suggested imports",
      description: `Discard suggested imports (from list_suggested_imports): the downloaded audio is deleted and the song is not suggested again for 90 days. Each id is handled separately; the result reports each one. Undo puts the suggestion back in the queue and downloads it again. ${UNDO_NOTE}`,
      inputSchema: z.object({ suggestionIds: suggestionIdList }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ suggestionIds }) => {
      const results = [];
      for (const suggestionId of unique(suggestionIds)) {
        const outcome = await db.transaction(async (tx) => {
          const rejected = await rejectSuggestedImport(userId, suggestionId, tx);
          if (rejected.status !== "ok") return rejected;
          const recorded = await recordAction(tx, {
            ...actor,
            summary: `Rejected suggested import "${rejected.artist} - ${rejected.title}"`,
            kind: "suggestion.reject",
            payload: { suggestionId, title: rejected.title, artist: rejected.artist },
          });
          return { ...rejected, recorded };
        });
        if (outcome.status === "ok") {
          await deleteObjectsBestEffort(outcome.objectKeys);
          results.push({
            suggestionId,
            status: "rejected",
            title: outcome.title,
            artist: outcome.artist,
            ...undoInfo(outcome.recorded),
          });
        } else {
          results.push({
            suggestionId,
            status: "failed",
            error:
              outcome.status === "not_found"
                ? "Suggestion not found"
                : "Suggestion is no longer ready",
          });
        }
      }
      if (results.some((r) => r.status === "rejected")) wakeSuggestedImportWorker();
      return ok({ results });
    }
  );

  defineTool(
    server,
    "create_share_link",
    {
      title: "Create share link",
      description: `Create a public link to one track. Anyone with the link can play the track for 7 days without an account, even if the track is later made private, so confirm with the user before calling this. If the track already has an active link, that link is returned unchanged. ${UNDO_NOTE}`,
      inputSchema: z.object({ trackId: uuid }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ trackId }) => {
      const access = await loadAccessibleTrack(userId, trackId);
      if (access.status !== "ok") return fail("Track not found");
      const { track } = access;
      const result = await db.transaction(async (tx) => {
        const link = await createOrGetShare(trackId, userId, tx);
        const recorded = link.created
          ? await recordAction(tx, {
              ...actor,
              summary: `Shared "${track.title}" publicly`,
              kind: "share.create",
              payload: { trackId, token: link.token, trackTitle: track.title },
            })
          : null;
        return { link, recorded };
      });
      return ok({
        url: `${ctx.base}/share/${result.link.token}`,
        expiresAt: result.link.expiresAt.toISOString(),
        created: result.link.created,
        ...(result.recorded && undoInfo(result.recorded)),
      });
    }
  );

  defineTool(
    server,
    "undo_action",
    {
      title: "Undo action",
      description:
        "Undo a change made through a connected app within the last 30 days (ids come from write-tool results or list_actions). Each item is restored only if nothing changed it since; the report lists what was restored and what was skipped, and why. An undo cannot itself be undone.",
      inputSchema: z.object({ actionId: uuid }),
      // Undoing a create or import deletes what it made.
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ actionId }) => {
      const result = await undoAction(userId, actionId);
      switch (result.status) {
        case "not_found":
          return fail("Action not found");
        case "expired":
          return fail("Undo window has passed");
        case "already_undone":
          return fail("Action was already undone");
        case "ok":
          return ok({ ...result.report });
      }
    }
  );
}
