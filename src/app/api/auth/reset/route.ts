import { createHash } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { z } from "zod";
import { db } from "@/db";
import { passwordResetTokens, sessions, users } from "@/db/schema";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  const tokenHash = createHash("sha256")
    .update(parsed.data.token)
    .digest("hex");
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    );
  if (!row) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired" },
      { status: 400 }
    );
  }

  const passwordHash = await hash(parsed.data.password, 12);
  const consumed = await db.transaction(async (tx) => {
    // Serialize resets for this account before claiming an individual token.
    // Otherwise two different valid links could race and leave the password at
    // whichever request happened to commit last.
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, row.userId))
      .for("update");
    if (!account) return false;

    const usedAt = new Date();
    // Burning the token is the atomic claim (the SELECT above is only a cheap
    // pre-check to skip the bcrypt work): two concurrent posts of the same
    // token can't both pass this UPDATE's usedAt guard.
    const [claim] = await tx
      .update(passwordResetTokens)
      .set({ usedAt })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          eq(passwordResetTokens.userId, account.id),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, usedAt)
        )
      )
      .returning({ userId: passwordResetTokens.userId });
    if (!claim) return false;

    // A password change invalidates every other outstanding reset link too.
    await tx
      .update(passwordResetTokens)
      .set({ usedAt })
      .where(
        and(
          eq(passwordResetTokens.userId, claim.userId),
          isNull(passwordResetTokens.usedAt)
        )
      );
    await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, claim.userId));
    // Log out every existing session for the account.
    await tx.delete(sessions).where(eq(sessions.userId, claim.userId));
    return true;
  });
  if (!consumed) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired" },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
