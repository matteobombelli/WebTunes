import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { recordListen, type ListenTelemetry } from "@/lib/listens";
import { isUuid } from "@/lib/validate";

const telemetrySchema = z.object({
  sessionId: z.string().uuid(),
  listenedSeconds: z.number().int().min(30).max(86400),
});

// Records a qualified play once actual playback reaches 30s, then accepts
// idempotent cumulative-duration checkpoints for that playback session. A
// body-less request remains supported for older/mobile clients.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const user = await requireUser();
  if (!user) return unauthorized();

  let telemetry: ListenTelemetry | null = null;
  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const parsed = telemetrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid listen telemetry" },
        { status: 400 }
      );
    }
    telemetry = parsed.data;
  }

  const result = await recordListen(user.id, id, telemetry);
  if (result === "not_found") {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  if (result === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return new NextResponse(null, { status: 204 });
}
