import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "@/db";
import {
  suggestedImports,
  trackIdentities,
  tracks,
  users,
  type SuggestedImport,
} from "@/db/schema";
import { ingestTrack, MAX_FILE_BYTES } from "@/lib/ingest";
import {
  candidatesForArtist,
  hasListenBrainzToken,
  lookupTaggedRecordingIdentities,
  type SuggestedCandidate,
  type TaggedRecordingIdentity,
} from "@/lib/import/listenbrainz";
import { DEFAULT_STRICTNESS, findMatch, MIN_SOURCE_KBPS } from "@/lib/import/match";
import type { SourceTrack } from "@/lib/import/sources";
import { downloadAudio, probeVideo } from "@/lib/import/ytdlp";
import { listTopTracks } from "@/lib/discover";
import { log } from "@/lib/log";
import { enqueueRecognition } from "@/lib/recognize-queue";
import { deleteObject } from "@/lib/s3";
import {
  listAccessibleTracks,
  isLibraryTrack,
  listOwnTracks,
  toTrackDTO,
  trackDtoColumns,
} from "@/lib/tracks";
import type {
  SuggestedImportPoolDTO,
  TrackDTO,
} from "@/lib/types";

const SUGGESTED_IMPORT_TARGET = 20;
const REJECT_MS = 90 * 24 * 60 * 60 * 1000;
const RETRY_FAILED_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30 * 60 * 1000;
const IDLE_MS = 60_000;
const MAX_SEED_ARTISTS = 5;
const IDENTITY_LOOKUP_BATCH = 25;
const ACOUSTID_FALLBACK_BATCH = 2;
const IDENTITY_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_ARTIST = 2;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;

function normalizeSuggestedText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function getSuggestedImportPool(
  userId: string
): Promise<SuggestedImportPoolDTO> {
  const rows = await db
    .select({ suggestion: suggestedImports, track: trackDtoColumns })
    .from(suggestedImports)
    .innerJoin(tracks, eq(tracks.suggestedImportId, suggestedImports.id))
    .where(
      and(
        eq(suggestedImports.userId, userId),
        eq(suggestedImports.status, "ready")
      )
    )
    // updatedAt becomes the ready time on the final import transition and then
    // stays unchanged. Sorting by it appends newly-ready cards instead of
    // inserting them among older cards based on when they were first queued.
    .orderBy(asc(suggestedImports.updatedAt), asc(suggestedImports.id));
  const [processingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(suggestedImports)
    .where(
      and(
        eq(suggestedImports.userId, userId),
        inArray(suggestedImports.status, ["queued", "importing"])
      )
    );
  let blockedReason: SuggestedImportPoolDTO["blockedReason"] = null;
  if (!rows.length && !processingRow?.count) {
    const [identity] = await db
      .select({ id: trackIdentities.trackId })
      .from(trackIdentities)
      .innerJoin(tracks, eq(trackIdentities.trackId, tracks.id))
      .where(
        and(
          eq(tracks.ownerId, userId),
          eq(trackIdentities.status, "recognized")
        )
      )
      .limit(1);
    if (!identity) {
      if (!hasListenBrainzToken()) {
        blockedReason = "no_key";
      } else {
        const [owned] = await db
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(eq(tracks.ownerId, userId), isLibraryTrack()))
          .limit(1);
        blockedReason = owned ? null : "no_seeds";
      }
    }
  }
  return {
    items: rows.map((row) => ({
      id: row.suggestion.id,
      track: { ...toTrackDTO(row.track), isSuggested: true },
      reason: row.suggestion.reason,
    })),
    target: SUGGESTED_IMPORT_TARGET,
    processing: processingRow?.count ?? 0,
    blockedReason,
  };
}

type SuggestionMutationResult =
  | { status: "ok"; track?: TrackDTO }
  | { status: "not_found" }
  | { status: "conflict" };

export async function acceptSuggestedImport(
  userId: string,
  suggestionId: string
): Promise<SuggestionMutationResult> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ suggestion: suggestedImports, track: tracks })
      .from(suggestedImports)
      .innerJoin(tracks, eq(tracks.suggestedImportId, suggestedImports.id))
      .where(
        and(
          eq(suggestedImports.id, suggestionId),
          eq(suggestedImports.userId, userId)
        )
      )
      .limit(1);
    if (!row) return { status: "not_found" } as const;
    if (row.suggestion.status !== "ready") return { status: "conflict" } as const;
    const acceptedAt = new Date();
    const [promoted] = await tx
      .update(tracks)
      .set({
        suggestedImportId: null,
        isPrivate: false,
        // Staging time is an implementation detail. Once accepted, the track
        // should enter the newest-first library at the moment the user kept it.
        createdAt: acceptedAt,
      })
      .where(
        and(
          eq(tracks.id, row.track.id),
          eq(tracks.suggestedImportId, suggestionId)
        )
      )
      .returning();
    if (!promoted) return { status: "conflict" } as const;
    await tx
      .update(suggestedImports)
      .set({ status: "accepted", updatedAt: acceptedAt, progress: 100 })
      .where(eq(suggestedImports.id, suggestionId));
    return { status: "ok", track: toTrackDTO(promoted) } as const;
  });
  if (result.status === "ok") wakeSuggestedImportWorker();
  return result;
}

export async function rejectSuggestedImport(
  userId: string,
  suggestionId: string
): Promise<SuggestionMutationResult> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ suggestion: suggestedImports, track: tracks })
      .from(suggestedImports)
      .innerJoin(tracks, eq(tracks.suggestedImportId, suggestedImports.id))
      .where(
        and(
          eq(suggestedImports.id, suggestionId),
          eq(suggestedImports.userId, userId)
        )
      )
      .limit(1);
    if (!row) return { result: { status: "not_found" } as const, keys: [] };
    if (row.suggestion.status !== "ready") {
      return { result: { status: "conflict" } as const, keys: [] };
    }
    await tx.delete(tracks).where(eq(tracks.id, row.track.id));
    await tx
      .update(suggestedImports)
      .set({
        status: "rejected",
        rejectedUntil: new Date(Date.now() + REJECT_MS),
        updatedAt: new Date(),
        progress: 0,
        error: null,
      })
      .where(eq(suggestedImports.id, suggestionId));
    return {
      result: { status: "ok" } as const,
      keys: [row.track.s3Key, row.track.artS3Key, row.track.artThumbS3Key].filter(
        (key): key is string => Boolean(key)
      ),
    };
  });
  for (const key of result.keys) await deleteObject(key).catch(() => {});
  if (result.result.status === "ok") wakeSuggestedImportWorker();
  return result.result;
}

let wake: (() => void) | null = null;
let started = false;

export function wakeSuggestedImportWorker(): void {
  wake?.();
  wake = null;
}

export function startSuggestedImportWorker(): void {
  if (started) return;
  started = true;
  void workerLoop();
}

async function waitForWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, IDLE_MS);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function workerLoop(): Promise<void> {
  while (true) {
    try {
      await recoverExpiredLeases();
      const allUsers = await db.select({ id: users.id }).from(users);
      for (const user of allUsers) await ensureCandidateQueue(user.id);
      const claimed = await claimCandidate();
      if (claimed) {
        await importCandidate(claimed);
        continue;
      }
    } catch (error) {
      log.warn(
        "suggested-imports",
        "worker iteration failed",
        error instanceof Error ? error.message : String(error)
      );
    }
    await waitForWork();
  }
}

async function recoverExpiredLeases(): Promise<void> {
  await db
    .update(suggestedImports)
    .set({ status: "queued", leaseExpiresAt: null, progress: 0, updatedAt: new Date() })
    .where(
      and(
        eq(suggestedImports.status, "importing"),
        lt(suggestedImports.leaseExpiresAt, new Date())
      )
    );
}

async function ensureCandidateQueue(userId: string): Promise<void> {
  const [active] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(suggestedImports)
    .where(
      and(
        eq(suggestedImports.userId, userId),
        inArray(suggestedImports.status, ["queued", "importing", "ready"])
      )
    );
  const missing = SUGGESTED_IMPORT_TARGET - (active?.count ?? 0);
  if (missing <= 0) return;

  let seeds = await listTopTracks(userId);
  if (!seeds.length) seeds = await listOwnTracks(userId, 100);
  if (!seeds.length) return;
  const identities = await db
    .select({
      trackId: trackIdentities.trackId,
      artistMbids: trackIdentities.artistMbids,
      status: trackIdentities.status,
      retryAfter: trackIdentities.retryAfter,
      sourceTrackId: tracks.id,
      s3Key: tracks.s3Key,
    })
    .from(tracks)
    .leftJoin(trackIdentities, eq(trackIdentities.trackId, tracks.id))
    .where(
      inArray(tracks.id, seeds.map((seed) => seed.id))
    );
  const identityByTrack = new Map(
    identities.flatMap((row) =>
      row.trackId && row.status === "recognized"
        ? [[row.trackId, { ...row, artistMbids: row.artistMbids ?? [] }] as const]
        : []
    )
  );
  const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
  const identityDue = identities.filter(
    (identity) =>
      identity.status !== "recognized" &&
      (!identity.retryAfter || identity.retryAfter.getTime() <= Date.now())
  );
  const textualRows = identityDue
    .filter((identity) => Boolean(seedById.get(identity.sourceTrackId)?.artist))
    .slice(0, IDENTITY_LOOKUP_BATCH);
  const textualMisses = new Set<string>();

  if (textualRows.length && hasListenBrainzToken()) {
    try {
      const lookup = await lookupTaggedRecordingIdentities(
        textualRows.map((identity) => {
          const seed = seedById.get(identity.sourceTrackId)!;
          return {
            trackId: identity.sourceTrackId,
            title: seed.title,
            artist: seed.artist!,
            album: seed.album,
          };
        })
      );
      await persistTextualIdentities(
        textualRows.map((row) => row.sourceTrackId),
        lookup
      );
      lookup.forEach((identity, index) => {
        if (!identity) textualMisses.add(textualRows[index].sourceTrackId);
      });

      // Include mappings found in this pass immediately; users need not wait
      // for another minute-long worker cycle before candidate discovery.
      for (const identity of lookup) {
        if (!identity) continue;
        identityByTrack.set(identity.trackId, {
          trackId: identity.trackId,
          artistMbids: identity.artistMbids,
          status: "recognized",
          retryAfter: null,
          sourceTrackId: identity.trackId,
          s3Key:
            identities.find((row) => row.sourceTrackId === identity.trackId)
              ?.s3Key ?? "",
        });
      }
    } catch (error) {
      // A timeout/auth failure is not an identity miss. Leave the rows due so
      // the next worker pass can retry instead of needlessly fingerprinting.
      log.warn(
        "suggested-imports",
        "ListenBrainz tag lookup failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // AcoustID is the slow fallback, never the normal seed path: use it only for
  // absent artist tags or a completed textual lookup that found no safe match.
  if (process.env.ACOUSTID_API_KEY) {
    const fallbackIds = new Set([
      ...identityDue
        .filter((identity) => !seedById.get(identity.sourceTrackId)?.artist)
        .map((identity) => identity.sourceTrackId),
      ...textualMisses,
    ]);
    for (const row of identities
      .filter((identity) => fallbackIds.has(identity.sourceTrackId))
      .slice(0, ACOUSTID_FALLBACK_BATCH)) {
      enqueueRecognition({
        trackId: row.sourceTrackId,
        s3Key: row.s3Key,
        ext: row.s3Key.split(".").pop()?.toLowerCase() ?? "bin",
        identify: true,
        forceIdentity: textualMisses.has(row.sourceTrackId),
      });
    }
  }
  const seedArtists: Array<{ artistMbid: string; artistName: string; weight: number }> = [];
  const seenArtists = new Set<string>();
  for (let index = 0; index < seeds.length; index++) {
    const seed = seeds[index];
    const identity = identityByTrack.get(seed.id);
    const artistMbid = identity?.artistMbids[0];
    if (!artistMbid || seenArtists.has(artistMbid)) continue;
    seenArtists.add(artistMbid);
    seedArtists.push({
      artistMbid,
      artistName: seed.artist ?? seed.title,
      weight: 1 - index / Math.max(1, seeds.length),
    });
    if (seedArtists.length >= MAX_SEED_ARTISTS) break;
  }
  if (!seedArtists.length) return;

  const candidates: SuggestedCandidate[] = [];
  for (const seed of seedArtists) {
    candidates.push(...(await candidatesForArtist(seed)));
  }
  if (!candidates.length) return;

  const [accessible, history] = await Promise.all([
    listAccessibleTracks(userId, false),
    db
      .select()
      .from(suggestedImports)
      .where(eq(suggestedImports.userId, userId)),
  ]);
  const accessibleIdentities = accessible.length
    ? await db
        .select({ recordingMbid: trackIdentities.recordingMbid })
        .from(trackIdentities)
        .where(inArray(trackIdentities.trackId, accessible.map((track) => track.id)))
    : [];
  const unavailableRecordings = new Set(
    accessibleIdentities.flatMap((identity) =>
      identity.recordingMbid ? [identity.recordingMbid] : []
    )
  );
  const unavailable = new Set(
    accessible.map(
      (track) =>
        `${normalizeSuggestedText(track.artist ?? "")}\u0000${normalizeSuggestedText(track.title)}`
    )
  );
  const byRecording = new Map(history.map((row) => [row.recordingMbid, row]));
  const now = Date.now();
  const familiar = candidates.filter((candidate) => !candidate.related);
  const related = candidates.filter((candidate) => candidate.related);
  familiar.sort((a, b) => b.score - a.score);
  related.sort((a, b) => b.score - a.score);
  const drafted: SuggestedCandidate[] = [];
  const artistCounts = new Map<string, number>();
  let familiarIndex = 0;
  let relatedIndex = 0;
  while (drafted.length < missing && (familiarIndex < familiar.length || relatedIndex < related.length)) {
    const source = drafted.length % 2 === 0 ? familiar : related;
    let candidate = source === familiar ? familiar[familiarIndex++] : related[relatedIndex++];
    if (!candidate) candidate = source === familiar ? related[relatedIndex++] : familiar[familiarIndex++];
    if (!candidate) continue;
    if (unavailableRecordings.has(candidate.recordingMbid)) continue;
    const key = `${normalizeSuggestedText(candidate.artist)}\u0000${normalizeSuggestedText(candidate.title)}`;
    if (unavailable.has(key)) continue;
    const old = byRecording.get(candidate.recordingMbid);
    const eligibleOld =
      old?.status === "rejected"
        ? !old.rejectedUntil || old.rejectedUntil.getTime() <= now
        : old?.status === "failed"
          ? old.updatedAt.getTime() <= now - RETRY_FAILED_MS
          : false;
    if (old && !eligibleOld) continue;
    const artistKey = candidate.artistMbid ?? normalizeSuggestedText(candidate.artist);
    const count = artistCounts.get(artistKey) ?? 0;
    if (count >= MAX_PER_ARTIST) continue;
    artistCounts.set(artistKey, count + 1);
    unavailable.add(key);
    drafted.push(candidate);
  }

  await db.transaction(async (tx) => {
    // Multiple overlapping Next processes can run briefly during deploys. Lock
    // only the short persistence phase (never the network calls above) so two
    // refillers cannot independently push one user past the 20-item cap.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`suggested:${userId}`}))`
    );
    const [current] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(suggestedImports)
      .where(
        and(
          eq(suggestedImports.userId, userId),
          inArray(suggestedImports.status, ["queued", "importing", "ready"])
        )
      );
    let remaining = SUGGESTED_IMPORT_TARGET - (current?.count ?? 0);
    for (const candidate of drafted) {
      if (remaining <= 0) break;
      const values = candidateValues(userId, candidate);
      const old = byRecording.get(candidate.recordingMbid);
      if (old) {
        await tx
          .update(suggestedImports)
          .set({
            ...values,
            status: "queued",
            progress: 0,
            error: null,
            rejectedUntil: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(suggestedImports.id, old.id));
      } else {
        await tx.insert(suggestedImports).values(values).onConflictDoNothing();
      }
      remaining--;
    }
  });
}

async function persistTextualIdentities(
  trackIds: string[],
  identities: Array<TaggedRecordingIdentity | null>
): Promise<void> {
  const attemptedAt = new Date();
  const retryAfter = new Date(attemptedAt.getTime() + IDENTITY_RETRY_MS);
  await db.transaction(async (tx) => {
    for (let index = 0; index < trackIds.length; index++) {
      const trackId = trackIds[index];
      const identity = identities[index];
      const values = identity
        ? {
            trackId,
            status: "recognized" as const,
            acoustidId: null,
            recordingMbid: identity.recordingMbid,
            artistMbids: identity.artistMbids,
            releaseGroupMbid: identity.releaseGroupMbid,
            attemptedAt,
            retryAfter: null,
          }
        : {
            trackId,
            status: "unmatched" as const,
            acoustidId: null,
            recordingMbid: null,
            artistMbids: [],
            releaseGroupMbid: null,
            attemptedAt,
            retryAfter,
          };
      await tx.insert(trackIdentities).values(values).onConflictDoNothing();
      await tx
        .update(trackIdentities)
        .set({
          status: values.status,
          acoustidId: values.acoustidId,
          recordingMbid: values.recordingMbid,
          artistMbids: values.artistMbids,
          releaseGroupMbid: values.releaseGroupMbid,
          attemptedAt: values.attemptedAt,
          retryAfter: values.retryAfter,
        })
        .where(
          and(
            eq(trackIdentities.trackId, trackId),
            sql`${trackIdentities.status} <> 'recognized'`
          )
        );
    }
  });
}

function candidateValues(userId: string, candidate: SuggestedCandidate) {
  return {
    userId,
    recordingMbid: candidate.recordingMbid,
    artistMbid: candidate.artistMbid,
    releaseGroupMbid: candidate.releaseGroupMbid,
    title: candidate.title.slice(0, 200),
    artist: candidate.artist.slice(0, 200),
    album: candidate.album.slice(0, 200) || null,
    durationSec: candidate.durationSec || null,
    artUrl: candidate.artUrl || null,
    normalizedTitle: normalizeSuggestedText(candidate.title),
    normalizedArtist: normalizeSuggestedText(candidate.artist),
    reason: candidate.reason.slice(0, 300),
    status: "queued" as const,
  };
}

async function claimCandidate(): Promise<SuggestedImport | null> {
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select()
      .from(suggestedImports)
      .where(eq(suggestedImports.status, "queued"))
      // Persistent priority queue: give the next import to the user with the
      // fewest delivered/in-flight suggestions. Unlike an in-memory cursor,
      // this stays fair across restarts and lets zero-ready users catch up
      // immediately after an initially FIFO-filled deployment.
      .orderBy(
        sql<number>`(
          select count(*)
          from suggested_imports as user_pool
          where user_pool.user_id = ${suggestedImports.userId}
            and user_pool.status in ('ready', 'importing')
        )`,
        asc(suggestedImports.createdAt)
      )
      .limit(1);
    if (!next) return null;
    const [claimed] = await tx
      .update(suggestedImports)
      .set({
        status: "importing",
        progress: 0,
        attemptCount: sql`${suggestedImports.attemptCount} + 1`,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(suggestedImports.id, next.id),
          eq(suggestedImports.status, "queued")
        )
      )
      .returning();
    return claimed ?? null;
  });
}

async function importCandidate(candidate: SuggestedImport): Promise<void> {
  const abort = new AbortController();
  let dir: string | null = null;
  try {
    const source: SourceTrack = {
      artist: candidate.artist,
      title: candidate.title,
      album: candidate.album ?? "",
      artUrl: candidate.artUrl ?? "",
      duration: candidate.durationSec ?? 0,
    };
    const match = await withSuggestedRetry(
      candidate.id,
      () =>
        findMatch(
          source,
          "none",
          DEFAULT_STRICTNESS,
          abort.signal,
          "suggested"
        )
    );
    if (match.url === null) throw new Error(match.reason);
    const info = await withSuggestedRetry(candidate.id, () =>
      probeVideo(match.url, abort.signal, "suggested")
    );
    if (info.bestAudioKbps > 0 && info.bestAudioKbps < MIN_SOURCE_KBPS) {
      throw new Error(
        `source ${Math.round(info.bestAudioKbps)} kbps < ${MIN_SOURCE_KBPS} kbps floor`
      );
    }
    dir = await mkdtemp(
      join(/* turbopackIgnore: true */ tmpdir(), "webtunes-suggested-")
    );
    const file = await withSuggestedRetry(candidate.id, () =>
      downloadAudio({
        url: match.url,
        quality: "opus",
        dir: dir!,
        signal: abort.signal,
        priority: "suggested",
        onProgress: (progress) => {
          void db
            .update(suggestedImports)
            .set({
              progress,
              leaseExpiresAt: new Date(Date.now() + LEASE_MS),
              updatedAt: new Date(),
            })
            .where(eq(suggestedImports.id, candidate.id));
        },
      })
    );
    const { size } = await stat(/* turbopackIgnore: true */ file.path);
    if (size > MAX_FILE_BYTES) throw new Error("file exceeds the 90 MB limit");
    const buffer = await readFile(/* turbopackIgnore: true */ file.path);
    const result = await ingestTrack({
      userId: candidate.userId,
      buffer,
      filename: file.filename,
      mimeType: file.mimeType,
      suggestedImportId: candidate.id,
      overrides: source,
      identity: {
        recordingMbid: candidate.recordingMbid,
        artistMbids: candidate.artistMbid ? [candidate.artistMbid] : [],
        releaseGroupMbid: candidate.releaseGroupMbid,
      },
    });
    if (result.status === "duplicate") throw new Error(result.message);
    await db
      .update(suggestedImports)
      .set({
        status: "ready",
        progress: 100,
        error: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(suggestedImports.id, candidate.id));
  } catch (error) {
    await db
      .update(suggestedImports)
      .set({
        status: "failed",
        progress: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(suggestedImports.id, candidate.id));
    log.info(
      "suggested-imports",
      `candidate failed ${candidate.artist} - ${candidate.title}`,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function withSuggestedRetry<T>(
  suggestionId: string,
  run: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const rateLimited =
        message.includes("429") || message.includes("too many requests");
      if (!rateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      await db
        .update(suggestedImports)
        .set({
          error: "YouTube is rate-limiting imports; retrying shortly",
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(suggestedImports.id, suggestionId));
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_COOLDOWN_MS)
      );
    }
  }
}
