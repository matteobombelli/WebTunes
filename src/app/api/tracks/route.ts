import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { extractTrackMetadata } from "@/lib/metadata";
import { uploadObject } from "@/lib/s3";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wav",
  "webm",
]);

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.ownerId, user.id))
    .orderBy(desc(tracks.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isAudio =
    file.type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext);
  if (!isAudio) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || ext}` },
      { status: 400 }
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File exceeds the 200 MB limit" },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const meta = await extractTrackMetadata(buffer, file.type, file.name);

  const trackId = randomUUID();
  const s3Key = `audio/${user.id}/${trackId}.${ext || "bin"}`;
  await uploadObject(s3Key, buffer, file.type || undefined);

  const [track] = await db
    .insert(tracks)
    .values({
      id: trackId,
      ownerId: user.id,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      durationSec: meta.durationSec,
      s3Key,
      mimeType: file.type || null,
      fileSize: file.size,
      lyrics: meta.lyrics,
      lyricsSource: meta.lyricsSource,
    })
    .returning();

  return NextResponse.json(track, { status: 201 });
}
