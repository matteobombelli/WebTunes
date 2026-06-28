import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/verification";

const schema = z.object({ email: z.string().trim().toLowerCase().email() });

// Resends a verification link. Always returns 200 (like forgot-password) so it
// can't be used to probe which emails exist or are already verified; the
// per-email rate limit keeps it from flooding an inbox.
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid email is required" },
      { status: 400 }
    );
  }

  // Per-IP cap bounds enumeration across addresses; per-email cap bounds inbox
  // flooding. Both silently 200 so neither becomes an existence oracle.
  const ip = getClientIp(req.headers);
  if (
    !rateLimit(`verify-resend-ip:${ip}`, 15, 60 * 60 * 1000) ||
    !rateLimit(`verify-resend:${parsed.data.email}`, 3, 60 * 60 * 1000)
  ) {
    return NextResponse.json({ ok: true });
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, parsed.data.email));
  if (user && !user.emailVerified) {
    // Out-of-band send (see forgot route) so response time doesn't reveal whether
    // the account exists or is already verified.
    void sendVerificationEmail(
      user.id,
      user.email,
      getAppBaseUrl(req.headers)
    ).catch((err) => console.error("Verification email failed:", err));
  }

  return NextResponse.json({ ok: true });
}
