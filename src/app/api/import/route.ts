import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { listJobs, startImport } from "@/lib/import/jobs";

const schema = z.object({
  url: z.string().trim().min(1).max(2000),
  quality: z.enum(["128", "192", "opus", "m4a"]).default("opus"),
  strictness: z.number().min(0).max(1).default(0.7),
  versionPref: z.enum(["none", "studio", "live"]).default("none"),
});

/**
 * Start a server-side import: a YouTube video/playlist URL, or a Spotify/Apple
 * Music URL whose tracks get matched to YouTube. The job runs on the global
 * serial import worker (lib/import/jobs.ts); progress is polled via GET.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid import request" }, { status: 400 });
  }
  const { url, quality, strictness, versionPref } = parsed.data;

  const result = startImport(user.id, url, { quality, strictness, versionPref });
  if (!result.ok) {
    const conflict = result.error === "An import is already running";
    return NextResponse.json(
      { error: result.error },
      { status: conflict ? 409 : 400 }
    );
  }
  return NextResponse.json({ jobId: result.jobId }, { status: 202 });
}

/** The session user's import jobs (newest first) — the client's poll target. */
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(listJobs(user.id));
}
