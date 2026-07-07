import { createHash } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { emailVerificationTokens, users } from "@/db/schema";

const schema = z.object({ token: z.string().min(1) });

// Consumes a single-use verification token and marks the account verified.
// Mirrors the password-reset flow: tokens are stored hashed, checked unused
// and unexpired, then burned in the same transaction as the verification.
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const tokenHash = createHash("sha256")
    .update(parsed.data.token)
    .digest("hex");
  // Burning the token is also the validity check — atomic, so two concurrent
  // posts of the same token can't both pass the usedAt guard.
  const consumed = await db.transaction(async (tx) => {
    const [claim] = await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, new Date())
        )
      )
      .returning({ userId: emailVerificationTokens.userId });
    if (!claim) return false;
    await tx
      .update(users)
      .set({ emailVerified: new Date() })
      .where(eq(users.id, claim.userId));
    return true;
  });
  if (!consumed) {
    return NextResponse.json(
      { error: "This verification link is invalid or has expired" },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
