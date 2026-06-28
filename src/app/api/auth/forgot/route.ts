import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { getClientIp } from "@/lib/client-ip";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({ email: z.string().trim().toLowerCase().email() });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  // Always 200 so the endpoint doesn't reveal which emails have accounts. Two
  // silent caps: per-IP bounds mass enumeration across many addresses; per-email
  // bounds inbox flooding for one address. Neither leaks existence.
  const ip = getClientIp(req.headers);
  if (
    !rateLimit(`forgot-ip:${ip}`, 15, 60 * 60 * 1000) ||
    !rateLimit(`forgot:${parsed.data.email}`, 3, 60 * 60 * 1000)
  ) {
    return NextResponse.json({ ok: true });
  }
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, parsed.data.email));
  if (user) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.insert(passwordResetTokens).values({
      tokenHash,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const resetUrl = `${getAppBaseUrl(req.headers)}/reset-password?token=${token}`;
    // Send out-of-band (don't await): the email-provider fetch is the dominant
    // timing signal, so awaiting it only in the user-exists branch turns response
    // time into an existence oracle. The reset token is already persisted above.
    void sendEmail({
      to: user.email,
      subject: "Reset your WebTunes password",
      text: `Someone (hopefully you) requested a password reset for WebTunes.\n\nReset it here (link valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    }).catch((err) => console.error("Password reset email failed:", err));
  }

  return NextResponse.json({ ok: true });
}
