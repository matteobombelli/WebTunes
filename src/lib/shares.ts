import { randomBytes } from "node:crypto";
import { cache } from "react";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { trackShares, tracks } from "@/db/schema";

// Public track-share links. A row is an unguessable capability: anyone holding
// the token can stream the track via /share/[token] with no account, so the
// token IS the authorization (it deliberately ignores is_private / friendship,
// unlike canAccessTrack). One active row per track; links auto-expire after 7
// days and are purged by scripts/purge-expired-shares.mjs. See AGENTS.md.
export const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ShareLink = { token: string; expiresAt: Date };

// The track fields the public stream/art routes and listen page need. Built by
// hand (NOT toTrackDTO, which would leak s3Key/ownerId/isPrivate into a DTO).
export type ResolvedShare = {
  id: string;
  s3Key: string;
  artS3Key: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
};

// The currently-active (non-expired) link for a track, or null. The dialog reads
// this on open so it can show an existing link without minting a new one.
export async function getActiveShare(trackId: string): Promise<ShareLink | null> {
  const [row] = await db
    .select({ token: trackShares.token, expiresAt: trackShares.expiresAt })
    .from(trackShares)
    .where(
      and(eq(trackShares.trackId, trackId), gt(trackShares.expiresAt, new Date()))
    );
  return row ?? null;
}

// Return the active link for a track, creating one if none exists. Atomic via
// upsert on the UNIQUE(track_id): an EXPIRED row is replaced (fresh token + 7
// days), an ACTIVE row is left untouched (re-sharing returns the same URL — to
// reset the clock the owner revokes then re-shares). This closes the
// create-create race where two callers would otherwise both insert.
export async function createOrGetShare(
  trackId: string,
  userId: string
): Promise<ShareLink> {
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + SHARE_TTL_MS);
  const [row] = await db
    .insert(trackShares)
    .values({ trackId, createdBy: userId, token, expiresAt })
    .onConflictDoUpdate({
      target: trackShares.trackId,
      set: { token, createdBy: userId, createdAt: sql`now()`, expiresAt },
      setWhere: lt(trackShares.expiresAt, new Date()),
    })
    .returning({ token: trackShares.token, expiresAt: trackShares.expiresAt });
  // Inserted, or replaced an expired row → DO UPDATE ran and returned the row.
  if (row) return row;
  // Conflict with an active row (setWhere was false → no row returned): return it.
  const existing = await getActiveShare(trackId);
  if (existing) return existing;
  // The active row expired in the microseconds between the upsert and the read;
  // retry once — now the setWhere matches and the expired row is replaced.
  return createOrGetShare(trackId, userId);
}

// Look up the track behind a share token, or null when the token is unknown or
// expired. Returns only the fields the public surfaces need. Wrapped in React
// cache so the listen page's generateMetadata + render share one query.
export const resolveShareToken = cache(async function resolveShareToken(
  token: string
): Promise<ResolvedShare | null> {
  const [row] = await db
    .select({
      id: tracks.id,
      s3Key: tracks.s3Key,
      artS3Key: tracks.artS3Key,
      title: tracks.title,
      artist: tracks.artist,
      album: tracks.album,
      durationSec: tracks.durationSec,
    })
    .from(trackShares)
    .innerJoin(tracks, eq(tracks.id, trackShares.trackId))
    .where(
      and(eq(trackShares.token, token), gt(trackShares.expiresAt, new Date()))
    );
  return row ?? null;
});

// Revoke a track's share link (deletes the row, freeing the UNIQUE slot). The
// caller has already verified the user owns the track.
export async function deleteShare(trackId: string): Promise<void> {
  await db.delete(trackShares).where(eq(trackShares.trackId, trackId));
}
