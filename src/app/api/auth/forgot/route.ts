import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { BASE_PATH } from "@/lib/base-path";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({ email: z.string().trim().toLowerCase().email() });

function appBaseUrl(req: NextRequest): string {
  const authUrl = process.env.AUTH_URL;
  if (authUrl) return authUrl.replace(/\/api\/auth\/?$/, "");
  return `${req.nextUrl.origin}${BASE_PATH}`;
}

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  // Always 200 so the endpoint doesn't reveal which emails have accounts.
  // Rate-limited per submitted address (account or not) so an attacker can't
  // flood someone's inbox with reset emails; the silent 200 keeps the
  // limiter itself from becoming an enumeration oracle.
  if (!rateLimit(`forgot:${parsed.data.email}`, 3, 60 * 60 * 1000)) {
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

    const resetUrl = `${appBaseUrl(req)}/reset-password?token=${token}`;
    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your WebTunes password",
        text: `Someone (hopefully you) requested a password reset for WebTunes.\n\nReset it here (link valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
      });
    } catch (err) {
      console.error("Password reset email failed:", err);
    }
  }

  return NextResponse.json({ ok: true });
}
