import { NextRequest, NextResponse } from "next/server";
import { requireImportToken, unauthorized } from "@/lib/auth-helpers";
import { revokeExtensionTokenByValue } from "@/lib/extension-tokens";

/**
 * Token-auth identity check: the extension popup calls this to show
 * "Connected as <name>" and to detect a revoked token (401 → re-pair).
 */
export async function GET(req: NextRequest) {
  const user = await requireImportToken(req);
  if (!user) return unauthorized();
  return NextResponse.json({ userName: user.name });
}

/** Self-revoke — the extension's Disconnect button. Idempotent-ish: a second
 * call finds the token already revoked and 401s, which the extension treats
 * as disconnected anyway. */
export async function DELETE(req: NextRequest) {
  const revoked = await revokeExtensionTokenByValue(
    req.headers.get("authorization")
  );
  if (!revoked) return unauthorized();
  return new NextResponse(null, { status: 204 });
}
