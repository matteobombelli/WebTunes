import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { getUserSettings, updateUserSettings } from "@/lib/users";

const patchSchema = z.object({
  hideFriendDuplicates: z.boolean().optional(),
  normalizeVolume: z.boolean().optional(),
  similarVariation: z.number().int().min(0).max(4).optional(),
});

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(await getUserSettings(user.id));
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  // An empty object passes the schema (the field is optional) but would make
  // Drizzle's .set({}) throw "No values to set" — guard it like the other
  // PATCH routes do.
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  return NextResponse.json(await updateUserSettings(user.id, parsed.data));
}
