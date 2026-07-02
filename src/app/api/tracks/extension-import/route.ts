import { NextRequest, NextResponse } from "next/server";
import { requireImportToken, unauthorized } from "@/lib/auth-helpers";
import { AUDIO_EXTENSIONS, ingestTrack, MAX_FILE_BYTES } from "@/lib/ingest";
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

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isAudio = file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext);
  if (!isAudio) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || ext}` },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 100 MB limit" },
      { status: 400 }
    );
  }

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

  // Provenance breadcrumb only — the URL isn't stored (no column, no need).
  const sourceUrl = form.get("sourceUrl");
  log.info(
    "extension-import",
    `imported ${result.track.id} for ${user.id}` +
      (typeof sourceUrl === "string" ? ` from ${sourceUrl.slice(0, 200)}` : "")
  );
  return NextResponse.json(toTrackDTO(result.track), { status: 201 });
}
