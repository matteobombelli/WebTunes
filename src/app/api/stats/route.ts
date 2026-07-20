import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getUserStats, isValidTimeZone } from "@/lib/stats";

const querySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "6m", "1y"]).default("30d"),
  tz: z.string().trim().min(1).max(100).default("UTC"),
});

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = querySchema.safeParse({
    range: req.nextUrl.searchParams.get("range") ?? undefined,
    tz: req.nextUrl.searchParams.get("tz") ?? undefined,
  });
  if (!parsed.success || !isValidTimeZone(parsed.data.tz)) {
    return NextResponse.json(
      { error: "Invalid stats range or time zone" },
      { status: 400 }
    );
  }

  return NextResponse.json(
    await getUserStats(user.id, parsed.data.range, parsed.data.tz),
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
