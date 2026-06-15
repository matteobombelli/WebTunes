import { createHash, randomBytes } from "crypto";
import { db } from "@/db";
import { emailVerificationTokens } from "@/db/schema";
import { sendEmail } from "@/lib/email";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Mints a single-use email-verification token, stores only its SHA-256 hash,
// and emails the user the verification link. Mirrors the password-reset flow.
// Throws if the email send fails; callers on the registration path swallow it
// (the account exists, and the user can request a fresh link via resend).
export async function sendVerificationEmail(
  userId: string,
  email: string,
  appBaseUrl: string
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.insert(emailVerificationTokens).values({
    tokenHash,
    userId,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  const verifyUrl = `${appBaseUrl}/verify-email?token=${token}`;
  await sendEmail({
    to: email,
    subject: "Verify your WebTunes email",
    text: `Welcome to WebTunes!\n\nConfirm your email to activate your account (link valid for 24 hours):\n${verifyUrl}\n\nIf you didn't create this account, you can ignore this email.`,
  });
}
