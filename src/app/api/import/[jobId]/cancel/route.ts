import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { cancelJob } from "@/lib/import/jobs";

/** Cancel an import job: aborts the in-flight yt-dlp child and marks the
 * remaining items cancelled. Ownership-checked inside cancelJob. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { jobId } = await params;
  if (!cancelJob(user.id, jobId)) {
    return NextResponse.json({ error: "Import not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
