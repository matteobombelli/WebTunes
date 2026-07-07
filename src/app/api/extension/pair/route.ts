import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/lib/client-ip";
import { redeemPairingCode } from "@/lib/extension-tokens";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  code: z.string().trim().min(4).max(32),
  // Browser label shown in the Settings revoke list; display-only.
  label: z.string().trim().max(80).optional(),
});

/**
 * Redeem a pairing code for a long-lived import token — the one unauthenticated
 * extension endpoint. IP-rate-limited so the 8-char code space can't be brute
 * forced within its 10-minute life.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!rateLimit(`ext-pair:${ip}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts — try again later." },
      { status: 429 }
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A pairing code is required" },
      { status: 400 }
    );
  }

  const result = await redeemPairingCode(
    parsed.data.code,
    parsed.data.label ?? null
  );
  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired pairing code" },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { token: result.token, userName: result.user.name },
    { status: 201 }
  );
}
