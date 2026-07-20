import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { ingestTrack, validateAudioUpload } from "@/lib/ingest";
import {
  listAccessibleTracks,
  listAccessibleTracksPage,
  listFriendsTracks,
  listFriendsTracksPage,
  listOwnTracks,
  listOwnTracksPage,
  parseTrackCursor,
  toTrackDTO,
} from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const limitParam = req.nextUrl.searchParams.get("limit");
  const cursorParam = req.nextUrl.searchParams.get("cursor");
  const limit = limitParam === null ? null : Number(limitParam);
  if (
    (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) ||
    (cursorParam !== null && limit === null)
  ) {
    return NextResponse.json(
      { error: "limit must be an integer from 1 to 200" },
      { status: 400 }
    );
  }
  let cursor;
  if (cursorParam !== null) {
    cursor = parseTrackCursor(cursorParam);
    if (!cursor) {
      return NextResponse.json({ error: "Invalid track cursor" }, { status: 400 });
    }
  }

  // scope=all adds friends' non-private tracks to the viewer's own; scope=friends
  // returns only friends' (own excluded) so that view doesn't over-fetch.
  const scope = req.nextUrl.searchParams.get("scope");
  if (scope === "all" || scope === "friends") {
    const { hideFriendDuplicates } = await getUserSettings(user.id);
    if (limit !== null) {
      return NextResponse.json(
        scope === "friends"
          ? await listFriendsTracksPage(
              user.id,
              hideFriendDuplicates,
              limit,
              cursor
            )
          : await listAccessibleTracksPage(
              user.id,
              hideFriendDuplicates,
              limit,
              cursor
            )
      );
    }
    return NextResponse.json(
      scope === "friends"
        ? await listFriendsTracks(user.id, hideFriendDuplicates)
        : await listAccessibleTracks(user.id, hideFriendDuplicates)
    );
  }
  if (limit !== null) {
    return NextResponse.json(await listOwnTracksPage(user.id, limit, cursor));
  }
  return NextResponse.json(await listOwnTracks(user.id));
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  // A truncated/garbage multipart body makes formData() reject - 400, not 500.
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 });
  }
  const upload = validateAudioUpload(form.get("file"));
  if (!upload.ok) {
    return NextResponse.json({ error: upload.error }, { status: 400 });
  }
  const file = upload.file;

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await ingestTrack({
    userId: user.id,
    buffer,
    filename: file.name,
    mimeType: file.type,
  });
  if (result.status === "duplicate") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }
  return NextResponse.json(toTrackDTO(result.track), { status: 201 });
}
