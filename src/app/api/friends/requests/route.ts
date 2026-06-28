import { and, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, isUniqueViolation } from "@/db";
import { friendships, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { pendingRequestsFor } from "@/lib/friends";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(await pendingRequestsFor(user.id));
}

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email));
  if (!target) {
    return NextResponse.json(
      { error: "No user with that email" },
      { status: 404 }
    );
  }
  if (target.id === user.id) {
    return NextResponse.json(
      { error: "You cannot befriend yourself" },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select({ id: friendships.id, status: friendships.status })
    .from(friendships)
    .where(
      or(
        and(
          eq(friendships.requesterId, user.id),
          eq(friendships.addresseeId, target.id)
        ),
        and(
          eq(friendships.requesterId, target.id),
          eq(friendships.addresseeId, user.id)
        )
      )
    );
  if (existing) {
    return NextResponse.json(
      {
        error:
          existing.status === "accepted"
            ? "Already friends"
            : "A request between you already exists",
      },
      { status: 409 }
    );
  }

  // Check-then-insert: two concurrent identical submissions can both pass the
  // existence check above, so catch the friendships_pair_idx unique violation
  // and return the normal 409 instead of a 500 (per the repo convention).
  try {
    const [row] = await db
      .insert(friendships)
      .values({ requesterId: user.id, addresseeId: target.id })
      .returning({ id: friendships.id });
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "A request between you already exists" },
        { status: 409 }
      );
    }
    throw err;
  }
}
