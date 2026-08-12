import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { bulkUpdateTrackMetadata } from "@/lib/tracks";

const patchSchema = z
  .object({
    trackIds: z.array(z.string().uuid()).min(1).max(10_000),
    artist: z.string().trim().max(200).nullable().optional(),
    album: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (new Set(data.trackIds).size !== data.trackIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["trackIds"],
        message: "trackIds must not contain duplicates",
      });
    }
    if (data.artist === undefined && data.album === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "artist or album is required",
      });
    }
  });

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "trackIds and at least one valid metadata field are required" },
      { status: 400 }
    );
  }

  const { trackIds, ...updates } = parsed.data;
  // A submitted empty string explicitly clears that field.
  if (updates.artist === "") updates.artist = null;
  if (updates.album === "") updates.album = null;

  const result = await bulkUpdateTrackMetadata(user.id, trackIds, updates);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (result.status === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (result.status === "suggested_import") {
    return NextResponse.json(
      { error: "Use Suggested Imports to accept or reject this track" },
      { status: 409 }
    );
  }
  return NextResponse.json({ updated: result.count });
}
