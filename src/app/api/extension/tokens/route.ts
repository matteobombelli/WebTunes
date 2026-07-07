import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { listExtensionTokens } from "@/lib/extension-tokens";

/** Connected importer extensions for the Settings revoke list. */
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(await listExtensionTokens(user.id));
}
