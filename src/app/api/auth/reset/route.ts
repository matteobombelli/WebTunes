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
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, row.userId));
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    // Log out every existing session for the account.
    await tx.delete(sessions).where(eq(sessions.userId, row.userId));
  });

  return NextResponse.json({ ok: true });
}
