import { and, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { friendships, users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const requester = alias(users, "requester");
  const addressee = alias(users, "addressee");
  const rows = await db
    .select({
      id: friendships.id,
      requesterId: friendships.requesterId,
      createdAt: friendships.createdAt,
      requester: { id: requester.id, name: requester.name, email: requester.email },
      addressee: { id: addressee.id, name: addressee.name, email: addressee.email },
    })
    .from(friendships)
    .innerJoin(requester, eq(friendships.requesterId, requester.id))
    .innerJoin(addressee, eq(friendships.addresseeId, addressee.id))
    .where(
      and(
        eq(friendships.status, "pending"),
        or(
          eq(friendships.requesterId, user.id),
          eq(friendships.addresseeId, user.id)
        )
      )
    );

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      direction: r.requesterId === user.id ? "outgoing" : "incoming",
      user: r.requesterId === user.id ? r.addressee : r.requester,
      createdAt: r.createdAt.toISOString(),
    }))
  );
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

  const [row] = await db
    .insert(friendships)
    .values({ requesterId: user.id, addresseeId: target.id })
    .returning({ id: friendships.id });
  return NextResponse.json({ id: row.id }, { status: 201 });
}
