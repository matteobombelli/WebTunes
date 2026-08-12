import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { recordListen } from "@/lib/listens";
import { isUuid } from "@/lib/validate";

const telemetrySchema = z.object({
  sessionId: z.string().uuid(),
  listenedSeconds: z.number().int().min(1).max(86400),
  durationSeconds: z.number().positive().max(86400),
});

// Records a qualified play once actual playback reaches 50% of the track, then
// accepts idempotent cumulative-duration checkpoints for that playback session.
export async function POST(
  req: NextRequest,
  { params }: RouteContext<"/api/tracks/[id]/play">
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const user = await requireUser();
  if (!user) return unauthorized();

  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json(
      { error: "Listen telemetry is required" },
      { status: 400 }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = telemetrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid listen telemetry" },
      { status: 400 }
    );
  }

  const result = await recordListen(user.id, id, parsed.data);
  if (result === "not_found") {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (result === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (result === "not_qualified") {
    return NextResponse.json(
      { error: "Listen has not reached 50% of the track" },
      { status: 422 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
