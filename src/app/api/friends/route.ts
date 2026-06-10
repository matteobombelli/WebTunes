import { inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { friendIdsOf } from "@/lib/friends";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const ids = await friendIdsOf(user.id);
  if (ids.length === 0) return NextResponse.json([]);

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return NextResponse.json(rows);
}
