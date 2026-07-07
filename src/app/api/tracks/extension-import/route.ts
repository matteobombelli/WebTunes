import { NextRequest, NextResponse } from "next/server";
import { requireImportToken, unauthorized } from "@/lib/auth-helpers";
import { ingestTrack, validateAudioUpload } from "@/lib/ingest";
import { log } from "@/lib/log";
import { toTrackDTO } from "@/lib/tracks";

/**
 * Track upload for the WebTunes Importer extension. Same pipeline as the
 * session-auth POST /api/tracks (ingestTrack), but authenticated with a bearer
 * import token — kept a separate route so token auth and session auth stay
 * cleanly split. The claimed MIME/filename are validated here and re-checked
 * inside ingestTrack exactly like a web upload; the extension's word is never
 * trusted for the stored Content-Type.
 */
export async function POST(req: NextRequest) {
  const user = await requireImportToken(req);
  if (!user) return unauthorized();

  // A truncated/garbage multipart body makes formData() reject — 400, not 500.
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 });
  }
  const upload = validateAudioUpload(form.get("file"));
  if (!upload.ok) {
    return NextResponse.json({ error: upload.error }, { status: 400 });
  }
  const file = upload.file;

  // The extension resolves title/artist/album + a cover-art URL client-side
  // (from the YouTube video, or the Spotify/Apple track it matched) and sends
  // them so the stored track is tagged deterministically. All untrusted:
  // strings become overrides, artUrl is fetched + byte-sniffed server-side.
  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v : undefined;
  };
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await ingestTrack({
    userId: user.id,
    buffer,
    filename: file.name,
    mimeType: file.type,
    overrides: {
      title: str("title"),
      artist: str("artist"),
      album: str("album"),
      artUrl: str("artUrl"),
      artCropSquare: str("artCropSquare") === "1",
    },
  });
  if (result.status === "duplicate") {
    return NextResponse.json({ error: result.message }, { status: 409 });
  }

  // Provenance breadcrumb only — the URL isn't stored (no column, no need).
  const sourceUrl = form.get("sourceUrl");
  log.info(
    "extension-import",
    `imported ${result.track.id} for ${user.id}` +
      (typeof sourceUrl === "string" ? ` from ${sourceUrl.slice(0, 200)}` : "")
  );
  return NextResponse.json(toTrackDTO(result.track), { status: 201 });
}
