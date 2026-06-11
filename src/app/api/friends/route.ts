import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { friendsOf } from "@/lib/friends";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(await friendsOf(user.id));
}
