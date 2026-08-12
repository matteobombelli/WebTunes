import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser } from "@/lib/auth-helpers";
import { canAccessTrack } from "@/lib/friends";
import { isUuid } from "@/lib/validate";

type MediaKind = "audio" | "art";
type MediaError = "unauthorized" | "not_found" | "forbidden";
type MediaResult =
  | { ok: true; key: string; thumbnailKey: string | null }
  | { ok: false; error: MediaError };

/** Resolve authenticated track media, including private Suggested Import previews. */
export async function resolveTrackMedia(
  id: string,
  kind: MediaKind
): Promise<MediaResult> {
  if (!isUuid(id)) return { ok: false, error: "not_found" };

  const [user, [track]] = await Promise.all([
    requireUser(),
    db
      .select({
        ownerId: tracks.ownerId,
        isPrivate: tracks.isPrivate,
        suggestedImportId: tracks.suggestedImportId,
        s3Key: tracks.s3Key,
        artS3Key: tracks.artS3Key,
        artThumbS3Key: tracks.artThumbS3Key,
      })
      .from(tracks)
      .where(eq(tracks.id, id)),
  ]);

  if (!user) return { ok: false, error: "unauthorized" };
  if (!track) return { ok: false, error: "not_found" };

  const canPreview =
    track.suggestedImportId !== null && track.ownerId === user.id;
  if (!canPreview && !(await canAccessTrack(user.id, track))) {
    return { ok: false, error: "forbidden" };
  }

  const key = kind === "audio" ? track.s3Key : track.artS3Key;
  if (!key) return { ok: false, error: "not_found" };
  return {
    ok: true,
    key,
    thumbnailKey: kind === "art" ? track.artThumbS3Key : null,
  };
}

export function trackMediaError(error: MediaError) {
  if (error === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ error: "Track not found" }, { status: 404 });
}
