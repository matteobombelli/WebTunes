import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { createPairingCode } from "@/lib/extension-tokens";
import { rateLimit } from "@/lib/rate-limit";

/** Mint a short-lived pairing code for the importer extension (Settings). */
export async function POST() {
  const user = await requireUser();
  if (!user) return unauthorized();
  // Session-authed, so key on the user: enough for honest re-clicks, stops a
  // stuck client from filling the table.
  if (!rateLimit(`ext-code:${user.id}`, 10, 10 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many codes requested - try again in a few minutes." },
      { status: 429 }
    );
  }
  return NextResponse.json(await createPairingCode(user.id), { status: 201 });
}
