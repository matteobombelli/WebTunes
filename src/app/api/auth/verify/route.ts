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
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, new Date())
      )
    );
  if (!row) {
    return NextResponse.json(
      { error: "This verification link is invalid or has expired" },
      { status: 400 }
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ emailVerified: new Date() })
      .where(eq(users.id, row.userId));
    await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(emailVerificationTokens.tokenHash, tokenHash));
  });

  return NextResponse.json({ ok: true });
}
