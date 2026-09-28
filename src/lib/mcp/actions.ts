import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  mcpActions,
  playlistCollaborators,
  playlists,
  playlistTracks,
  trackShares,
  tracks,
} from "@/db/schema";
import { cancelJob, getJob } from "@/lib/import/jobs";
import {
  deleteOwnedPlaylist,
  insertPlaylistTracksAt,
  lockEditablePlaylist,
  removePlaylistTracks,
  reorderPlaylistTracks,
  updatePlaylist,
} from "@/lib/playlists";
import { deleteObjectsBestEffort } from "@/lib/s3";
import { deleteShare } from "@/lib/shares";
import {
  requeueRejectedSuggestion,
  revertAcceptedSuggestion,
  wakeSuggestedImportWorker,
  type SuggestionUndoResult,
} from "@/lib/suggested-imports";
import {
  deleteOwnedTrack,
  loadOwnedLibraryTrack,
  updateTrackMetadata,
  type TrackMetadataFields,
} from "@/lib/tracks";
import type {
  McpActionDTO,
  McpActionKind,
  McpActionPageDTO,
  UndoReportDTO,
} from "@/lib/types";
import { isUuid } from "@/lib/validate";

/** Undo is refused after this; scripts/purge-mcp-state.mjs deletes older rows. */
export const MCP_UNDO_WINDOW_DAYS = 30;
export const MCP_UNDO_WINDOW_MS = MCP_UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const id = z.string().refine(isUuid, "Expected a UUID");
const playlistIdentity = { playlistId: id, playlistName: z.string() };
const playlistFields = z.object({
  name: z.string().optional(),
  isPrivate: z.boolean().optional(),
});
const trackFields = z.object({
  title: z.string().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
  isPrivate: z.boolean().optional(),
});

// Payloads hold what undo compares against. `before`/`after` carry only the
// fields the action changed; `after` is the value as stored (artist/album ""
// already normalized to null).
const payloadSchemas = {
  "playlist.create": z.object({
    playlistId: id,
    name: z.string(),
    trackIds: z.array(id),
    /** playlists.updated_at as Postgres text, keeping the microseconds a Date would drop. */
    updatedAt: z.string(),
  }),
  "playlist.update": z.object({
    ...playlistIdentity,
    before: playlistFields,
    after: playlistFields,
  }),
  "playlist.add_tracks": z.object({ ...playlistIdentity, trackIds: z.array(id) }),
  "playlist.remove_tracks": z.object({
    ...playlistIdentity,
    removed: z.array(
      z.object({ trackId: id, position: z.number().int().nonnegative() })
    ),
  }),
  "playlist.reorder": z.object({
    ...playlistIdentity,
    before: z.array(id),
    after: z.array(id),
  }),
  "track.update_metadata": z.object({
    items: z.array(
      z.object({ trackId: id, before: trackFields, after: trackFields })
    ),
  }),
  "import.start": z.object({
    jobId: z.string(),
    url: z.string(),
    createdTrackIds: z.array(id),
    /** Metadata of each created track as imported, parallel to createdTrackIds. */
    createdTracks: z.array(
      z.object({
        title: z.string().nullable(),
        artist: z.string().nullable(),
        album: z.string().nullable(),
      })
    ),
  }),
  "suggestion.accept": z.object({
    suggestionId: id,
    trackId: id,
    previousCreatedAt: z.iso.datetime(),
  }),
  "suggestion.reject": z.object({
    suggestionId: id,
    title: z.string(),
    artist: z.string(),
  }),
  "share.create": z.object({
    trackId: id,
    token: z.string(),
    trackTitle: z.string(),
  }),
} satisfies Record<McpActionKind, z.ZodType>;

export type McpActionPayloads = {
  [K in McpActionKind]: z.infer<(typeof payloadSchemas)[K]>;
};

export type McpActionRecord = {
  [K in McpActionKind]: { kind: K; payload: McpActionPayloads[K] };
}[McpActionKind];

function parseRecord(kind: McpActionKind, payload: unknown): McpActionRecord {
  return {
    kind,
    payload: payloadSchemas[kind].parse(payload),
  } as McpActionRecord;
}

/** Must be called inside the transaction that performs the mutation. */
export async function recordAction(
  tx: DbTransaction,
  input: {
    userId: string;
    grantId: string | null;
    clientName: string;
    summary: string;
  } & McpActionRecord
): Promise<{ id: string; undoableUntil: Date }> {
  const { payload } = parseRecord(input.kind, input.payload);
  const [row] = await tx
    .insert(mcpActions)
    .values({
      userId: input.userId,
      grantId: input.grantId,
      clientName: input.clientName,
      kind: input.kind,
      summary: input.summary,
      payload,
    })
    .returning({ id: mcpActions.id, createdAt: mcpActions.createdAt });
  return {
    id: row.id,
    undoableUntil: new Date(row.createdAt.getTime() + MCP_UNDO_WINDOW_MS),
  };
}

/** playlists.updated_at as text, for the playlist.create payload. */
export async function playlistUpdatedAt(
  tx: DbTransaction,
  playlistId: string
): Promise<string> {
  const [row] = await tx
    .select({ updatedAt: sql<string>`${playlists.updatedAt}::text` })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  return row.updatedAt;
}

/**
 * Record a track an import.start action created, with its metadata as it is
 * now. Returns false when the action is already undone (or missing): undo could
 * not see this track, so the caller should delete it itself.
 */
export async function appendImportedTrack(
  actionId: string,
  trackId: string
): Promise<boolean> {
  // Both arrays grow in one statement, so they stay parallel.
  const snapshot = sql`(select jsonb_build_object('title', ${tracks.title},
      'artist', ${tracks.artist}, 'album', ${tracks.album})
    from ${tracks} where ${tracks.id} = ${trackId})`;
  const updated = await db
    .update(mcpActions)
    .set({
      payload: sql`${mcpActions.payload} || jsonb_build_object(
        'createdTrackIds', coalesce(${mcpActions.payload}->'createdTrackIds', '[]'::jsonb)
          || jsonb_build_array(${trackId}::text),
        'createdTracks', coalesce(${mcpActions.payload}->'createdTracks', '[]'::jsonb)
          || jsonb_build_array(coalesce(${snapshot},
            jsonb_build_object('title', null, 'artist', null, 'album', null))))`,
    })
    .where(
      and(
        eq(mcpActions.id, actionId),
        eq(mcpActions.kind, "import.start"),
        eq(mcpActions.status, "applied")
      )
    )
    .returning({ id: mcpActions.id });
  return updated.length > 0;
}

function toActionDTO(row: typeof mcpActions.$inferSelect): McpActionDTO {
  const undoableUntil = new Date(row.createdAt.getTime() + MCP_UNDO_WINDOW_MS);
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    clientName: row.clientName,
    createdAt: row.createdAt.toISOString(),
    undoableUntil: undoableUntil.toISOString(),
    status: row.status,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undoReport: (row.undoReport as UndoReportDTO | null) ?? null,
    canUndo: row.status === "applied" && Date.now() < undoableUntil.getTime(),
  };
}

export const MAX_ACTIONS_PAGE = 100;

/** Newest first. `before` is the previous page's nextCursor (an action id). */
export async function listActions(
  userId: string,
  { limit = 50, before }: { limit?: number; before?: string } = {}
): Promise<McpActionPageDTO> {
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), MAX_ACTIONS_PAGE);
  if (before !== undefined && !isUuid(before)) {
    return { actions: [], nextCursor: null };
  }
  const rows = await db
    .select()
    .from(mcpActions)
    .where(
      and(
        eq(mcpActions.userId, userId),
        before === undefined
          ? undefined
          : sql`(${mcpActions.createdAt}, ${mcpActions.id}) < (
              select c.created_at, c.id from ${mcpActions} c
              where c.id = ${before} and c.user_id = ${userId}
            )`
      )
    )
    .orderBy(desc(mcpActions.createdAt), desc(mcpActions.id))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  return {
    actions: page.map(toActionDTO),
    nextCursor: rows.length > pageSize ? page[page.length - 1].id : null,
  };
}

export type UndoActionResult =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "already_undone" }
  | { status: "ok"; report: UndoReportDTO };

type UndoOutcome = UndoReportDTO & {
  /** S3 objects to delete after commit. */
  objectKeys: string[];
  wakeWorker: boolean;
};

function outcome(): UndoOutcome {
  return { restored: [], skipped: [], objectKeys: [], wakeWorker: false };
}

const ACTIVE_IMPORT = new Set(["queued", "resolving", "running"]);

function isExpired(createdAt: Date): boolean {
  return Date.now() >= createdAt.getTime() + MCP_UNDO_WINDOW_MS;
}

export async function undoAction(
  userId: string,
  actionId: string
): Promise<UndoActionResult> {
  if (!isUuid(actionId)) return { status: "not_found" };
  const [pre] = await db
    .select({
      kind: mcpActions.kind,
      payload: mcpActions.payload,
      status: mcpActions.status,
      createdAt: mcpActions.createdAt,
    })
    .from(mcpActions)
    .where(and(eq(mcpActions.id, actionId), eq(mcpActions.userId, userId)));
  if (!pre) return { status: "not_found" };
  if (pre.status === "undone") return { status: "already_undone" };
  if (isExpired(pre.createdAt)) return { status: "expired" };

  // Cancel before taking the row lock: appendImportedTrack calls from items
  // that finish meanwhile then either land before the locked re-read below or
  // block on the lock and no-op against the undone row.
  let cancelledImport = false;
  const preRecord = parseRecord(pre.kind, pre.payload);
  if (preRecord.kind === "import.start") {
    const job = getJob(userId, preRecord.payload.jobId);
    if (job && ACTIVE_IMPORT.has(job.status)) {
      cancelledImport = cancelJob(userId, preRecord.payload.jobId);
    }
  }

  const result = await db.transaction(async (tx) => {
    const [action] = await tx
      .select()
      .from(mcpActions)
      .where(and(eq(mcpActions.id, actionId), eq(mcpActions.userId, userId)))
      .for("update");
    if (!action) return { status: "not_found" } as const;
    if (action.status === "undone") return { status: "already_undone" } as const;
    if (isExpired(action.createdAt)) return { status: "expired" } as const;

    const record = parseRecord(action.kind, action.payload);
    const out = await undoRecord(tx, userId, action, record);
    if (cancelledImport) out.restored.unshift("Cancelled the running import");
    const report: UndoReportDTO = {
      restored: out.restored,
      skipped: out.skipped,
    };
    await tx
      .update(mcpActions)
      .set({ status: "undone", undoneAt: new Date(), undoReport: report })
      .where(eq(mcpActions.id, actionId));
    return { status: "ok", report, out } as const;
  });

  if (result.status !== "ok") return result;
  await deleteObjectsBestEffort(result.out.objectKeys);
  if (result.out.wakeWorker) wakeSuggestedImportWorker();
  return { status: "ok", report: result.report };
}

function undoRecord(
  tx: DbTransaction,
  userId: string,
  action: typeof mcpActions.$inferSelect,
  record: McpActionRecord
): Promise<UndoOutcome> {
  switch (record.kind) {
    case "playlist.create":
      return undoPlaylistCreate(tx, userId, action, record.payload);
    case "playlist.update":
      return undoPlaylistUpdate(tx, userId, record.payload);
    case "playlist.add_tracks":
      return undoPlaylistAdd(tx, userId, record.payload);
    case "playlist.remove_tracks":
      return undoPlaylistRemove(tx, userId, record.payload);
    case "playlist.reorder":
      return undoPlaylistReorder(tx, userId, record.payload);
    case "track.update_metadata":
      return undoTrackMetadata(tx, userId, record.payload);
    case "import.start":
      return undoImport(tx, userId, record.payload);
    case "suggestion.accept":
      return undoSuggestionAccept(tx, userId, record.payload);
    case "suggestion.reject":
      return undoSuggestionReject(tx, userId, record.payload);
    case "share.create":
      return undoShare(tx, userId, record.payload);
  }
}

function playlistLabel(name: string): string {
  return `Playlist "${name}"`;
}

function playlistRef(name: string): string {
  return `playlist "${name}"`;
}

function trackLabel(track: { title: string; artist: string | null }): string {
  return track.artist ? `"${track.title}" by ${track.artist}` : `"${track.title}"`;
}

async function trackLabels(
  tx: DbTransaction,
  trackIds: string[]
): Promise<(trackId: string) => string> {
  const rows = trackIds.length
    ? await tx
        .select({ id: tracks.id, title: tracks.title, artist: tracks.artist })
        .from(tracks)
        .where(inArray(tracks.id, trackIds))
    : [];
  const labels = new Map(rows.map((r) => [r.id, trackLabel(r)]));
  return (trackId) => labels.get(trackId) ?? "A deleted track";
}

/** Why an editable-playlist lock failed: gone, or the user lost edit access. */
async function playlistUnavailableReason(
  tx: DbTransaction,
  playlistId: string
): Promise<string> {
  const [row] = await tx
    .select({ id: playlists.id })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  return row ? "You can no longer edit this playlist" : "Playlist was deleted";
}

async function undoPlaylistCreate(
  tx: DbTransaction,
  userId: string,
  action: typeof mcpActions.$inferSelect,
  p: McpActionPayloads["playlist.create"]
): Promise<UndoOutcome> {
  const out = outcome();
  const label = playlistLabel(p.name);
  const [playlist] = await tx
    .select()
    .from(playlists)
    .where(eq(playlists.id, p.playlistId))
    .for("update");
  if (!playlist) {
    out.skipped.push({ item: label, reason: "Already deleted" });
    return out;
  }
  if (playlist.ownerId !== userId) {
    out.skipped.push({ item: label, reason: "Only the owner can delete it" });
    return out;
  }
  // Every name, privacy and membership change bumps updated_at; covers and
  // collaborators do not, so they are checked directly.
  const [state] = await tx
    .select({
      sameVersion: sql<boolean>`${playlists.updatedAt} = ${p.updatedAt}::timestamp`,
      hasCollaborators: sql<boolean>`exists (
        select 1 from ${playlistCollaborators}
        where ${playlistCollaborators.playlistId} = ${p.playlistId})`,
    })
    .from(playlists)
    .where(eq(playlists.id, p.playlistId));
  const unchanged =
    state.sameVersion && !state.hasCollaborators && playlist.coverS3Key === null;
  if (!unchanged) {
    const later = await tx
      .select({ summary: mcpActions.summary })
      .from(mcpActions)
      .where(
        and(
          eq(mcpActions.userId, userId),
          eq(mcpActions.status, "applied"),
          ne(mcpActions.id, action.id),
          gt(mcpActions.createdAt, action.createdAt),
          sql`${mcpActions.payload}->>'playlistId' = ${p.playlistId}`
        )
      )
      .orderBy(desc(mcpActions.createdAt));
    out.skipped.push({
      item: label,
      reason: later.length
        ? `Undo ${later.map((l) => `"${l.summary}"`).join(", ")} first`
        : "Changed since it was created",
    });
    return out;
  }
  const deleted = await deleteOwnedPlaylist(p.playlistId, userId, tx);
  if (deleted.status === "ok") {
    out.objectKeys.push(...deleted.objectKeys);
    out.restored.push(`Deleted ${playlistRef(p.name)}`);
  } else {
    out.skipped.push({ item: label, reason: "Already deleted" });
  }
  return out;
}

async function undoPlaylistUpdate(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["playlist.update"]
): Promise<UndoOutcome> {
  const out = outcome();
  const playlist = await lockEditablePlaylist(tx, p.playlistId, userId);
  if (!playlist) {
    out.skipped.push({
      item: playlistLabel(p.playlistName),
      reason: await playlistUnavailableReason(tx, p.playlistId),
    });
    return out;
  }
  const label = playlistLabel(playlist.name);
  const restore: { name?: string; isPrivate?: boolean } = {};
  if (p.after.name !== undefined && p.before.name !== undefined) {
    if (playlist.name === p.after.name) restore.name = p.before.name;
    else out.skipped.push({ item: `${label} name`, reason: "Changed since" });
  }
  if (p.after.isPrivate !== undefined && p.before.isPrivate !== undefined) {
    if (playlist.isPrivate !== p.after.isPrivate) {
      out.skipped.push({ item: `${label} privacy`, reason: "Changed since" });
    } else if (playlist.ownerId !== userId) {
      out.skipped.push({
        item: `${label} privacy`,
        reason: "Only the owner can change privacy",
      });
    } else {
      restore.isPrivate = p.before.isPrivate;
    }
  }
  if (restore.name === undefined && restore.isPrivate === undefined) return out;
  const result = await updatePlaylist(p.playlistId, userId, restore, tx);
  if (result.status !== "ok") {
    // The lock above already checked access; unreachable in practice.
    out.skipped.push({ item: label, reason: "You can no longer edit this playlist" });
    return out;
  }
  if (restore.name !== undefined) {
    out.restored.push(`Renamed ${playlistRef(playlist.name)} back to "${restore.name}"`);
  }
  if (restore.isPrivate !== undefined) {
    out.restored.push(
      `Made ${playlistRef(result.playlist.name)} ${
        restore.isPrivate ? "private" : "visible to friends"
      } again`
    );
  }
  return out;
}

async function undoPlaylistAdd(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["playlist.add_tracks"]
): Promise<UndoOutcome> {
  const out = outcome();
  const label = await trackLabels(tx, p.trackIds);
  const result = await removePlaylistTracks(p.playlistId, userId, p.trackIds, tx);
  if (result.status !== "ok") {
    const reason = await playlistUnavailableReason(tx, p.playlistId);
    for (const trackId of p.trackIds) out.skipped.push({ item: label(trackId), reason });
    return out;
  }
  const removed = new Set(result.removed.map((r) => r.trackId));
  const where = `"${p.playlistName}"`;
  for (const trackId of p.trackIds) {
    if (removed.has(trackId)) {
      out.restored.push(`Removed ${label(trackId)} from ${where}`);
    } else {
      out.skipped.push({ item: label(trackId), reason: "No longer in the playlist" });
    }
  }
  return out;
}

const INSERT_SKIP_REASONS = {
  already_present: "Already back in the playlist",
  missing: "Track was deleted",
  inaccessible: "You can no longer access this track",
} as const;

async function undoPlaylistRemove(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["playlist.remove_tracks"]
): Promise<UndoOutcome> {
  const out = outcome();
  const ids = p.removed.map((r) => r.trackId);
  const label = await trackLabels(tx, ids);
  const result = await insertPlaylistTracksAt(p.playlistId, userId, p.removed, tx);
  if (result.status !== "ok") {
    const reason = await playlistUnavailableReason(tx, p.playlistId);
    for (const trackId of ids) out.skipped.push({ item: label(trackId), reason });
    return out;
  }
  const where = `"${p.playlistName}"`;
  for (const trackId of result.inserted) {
    out.restored.push(`Put ${label(trackId)} back in ${where}`);
  }
  for (const s of result.skipped) {
    out.skipped.push({ item: label(s.trackId), reason: INSERT_SKIP_REASONS[s.reason] });
  }
  return out;
}

async function undoPlaylistReorder(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["playlist.reorder"]
): Promise<UndoOutcome> {
  const out = outcome();
  const playlist = await lockEditablePlaylist(tx, p.playlistId, userId);
  if (!playlist) {
    out.skipped.push({
      item: `Order of ${playlistRef(p.playlistName)}`,
      reason: await playlistUnavailableReason(tx, p.playlistId),
    });
    return out;
  }
  const item = `Order of ${playlistRef(playlist.name)}`;
  const current = await tx
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, p.playlistId))
    .orderBy(asc(playlistTracks.position));
  const unchanged =
    current.length === p.after.length &&
    current.every((c, i) => c.trackId === p.after[i]);
  if (!unchanged) {
    out.skipped.push({ item, reason: "Order changed since" });
    return out;
  }
  const result = await reorderPlaylistTracks(p.playlistId, userId, p.before, tx);
  if (result.status === "ok") out.restored.push(item);
  else out.skipped.push({ item, reason: "Order changed since" });
  return out;
}

const TRACK_FIELDS = ["title", "artist", "album", "isPrivate"] as const;

function storedValue<T>(value: T): T | null {
  return value === "" ? null : value;
}

async function undoTrackMetadata(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["track.update_metadata"]
): Promise<UndoOutcome> {
  const out = outcome();
  for (const { trackId, before, after } of p.items) {
    const owned = await loadOwnedLibraryTrack(userId, trackId, tx);
    if (owned.status !== "ok") {
      out.skipped.push({
        item: before.title ? `"${before.title}"` : "A deleted track",
        reason: "Track was deleted",
      });
      continue;
    }
    const { track } = owned;
    const label = trackLabel(track);
    const restore: TrackMetadataFields = {};
    const changedSince: string[] = [];
    for (const field of TRACK_FIELDS) {
      if (after[field] === undefined || before[field] === undefined) continue;
      if (track[field] === storedValue(after[field])) {
        Object.assign(restore, { [field]: before[field] });
      } else {
        changedSince.push(field === "isPrivate" ? "privacy" : field);
      }
    }
    if (changedSince.length) {
      out.skipped.push({
        item: `${label} ${changedSince.join(", ")}`,
        reason: "Changed since",
      });
    }
    const fields = Object.keys(restore);
    if (fields.length === 0) continue;
    await updateTrackMetadata(userId, trackId, restore, tx);
    out.restored.push(
      `${label} ${fields
        .map((f) => (f === "isPrivate" ? "privacy" : f))
        .join(", ")}`
    );
  }
  return out;
}

async function undoImport(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["import.start"]
): Promise<UndoOutcome> {
  const out = outcome();
  for (const [i, trackId] of p.createdTrackIds.entries()) {
    // Locked first, so a concurrent playlist add or share waits on its foreign key.
    const owned = await loadOwnedLibraryTrack(userId, trackId, tx);
    if (owned.status !== "ok") {
      out.skipped.push({ item: "An imported track", reason: "Already deleted" });
      continue;
    }
    const { track } = owned;
    const label = trackLabel(track);
    const [inPlaylist] = await tx
      .select({ playlistId: playlistTracks.playlistId })
      .from(playlistTracks)
      .where(eq(playlistTracks.trackId, trackId))
      .limit(1);
    if (inPlaylist) {
      out.skipped.push({ item: label, reason: "In a playlist" });
      continue;
    }
    const [shared] = await tx
      .select({ id: trackShares.id })
      .from(trackShares)
      .where(eq(trackShares.trackId, trackId));
    if (shared) {
      out.skipped.push({ item: label, reason: "Has a public share link" });
      continue;
    }
    // Recognition fills missing artist/album after import, so only a change
    // to a value that existed at import time counts as an edit.
    const imported = p.createdTracks[i];
    const edited = (["title", "artist", "album"] as const).some(
      (field) => imported[field] != null && track[field] !== imported[field]
    );
    if (edited) {
      out.skipped.push({ item: label, reason: "Metadata edited since import" });
      continue;
    }
    const deleted = await deleteOwnedTrack(userId, trackId, tx);
    if (deleted.status === "ok") {
      out.objectKeys.push(...deleted.objectKeys);
      out.restored.push(`Deleted ${label}`);
    } else {
      out.skipped.push({ item: label, reason: "Already deleted" });
    }
  }
  return out;
}

function suggestionOutcome(
  result: SuggestionUndoResult,
  fallbackTitle: string,
  restoredText: (title: string) => string
): UndoOutcome {
  const out = outcome();
  if (result.status === "ok") {
    out.restored.push(restoredText(result.title));
  } else {
    out.skipped.push({
      item: result.title ?? fallbackTitle,
      reason: result.reason,
    });
  }
  return out;
}

async function undoSuggestionAccept(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["suggestion.accept"]
): Promise<UndoOutcome> {
  const result = await revertAcceptedSuggestion(
    userId,
    p.suggestionId,
    p.trackId,
    new Date(p.previousCreatedAt),
    tx
  );
  return suggestionOutcome(
    result,
    "A suggested import",
    (title) => `Moved "${title}" back to Suggested Imports`
  );
}

async function undoSuggestionReject(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["suggestion.reject"]
): Promise<UndoOutcome> {
  const result = await requeueRejectedSuggestion(userId, p.suggestionId, tx);
  const out = suggestionOutcome(
    result,
    `"${p.artist} - ${p.title}"`,
    (title) =>
      `Restored "${title}" to Suggested Imports; its audio will be downloaded again`
  );
  out.wakeWorker = result.status === "ok";
  return out;
}

async function undoShare(
  tx: DbTransaction,
  userId: string,
  p: McpActionPayloads["share.create"]
): Promise<UndoOutcome> {
  const out = outcome();
  const item = `Share link for "${p.trackTitle}"`;
  const [share] = await tx
    .select({ ownerId: tracks.ownerId, expiresAt: trackShares.expiresAt })
    .from(trackShares)
    .innerJoin(tracks, eq(tracks.id, trackShares.trackId))
    .where(and(eq(trackShares.trackId, p.trackId), eq(trackShares.token, p.token)));
  // Only the owner may revoke (as on the web), since createOrGetShare hands
  // this same token to the owner if they share the track later.
  if (share && share.ownerId !== userId) {
    out.skipped.push({
      item,
      reason:
        share.expiresAt.getTime() > Date.now()
          ? `Only the track's owner can revoke a share link; it expires on its own on ${share.expiresAt.toUTCString()}`
          : "Link has already expired",
    });
    return out;
  }
  if (share && (await deleteShare(p.trackId, p.token, tx))) {
    out.restored.push(`Revoked the share link for "${p.trackTitle}"`);
  } else {
    out.skipped.push({ item, reason: "Link was already revoked or replaced" });
  }
  return out;
}
