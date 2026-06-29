import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { searchUsers } from "@/lib/users";

// Username search for adding friends. Returns up to 10 matches (id + username
// only — never email), excluding the searcher. Empty query → [].
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchUsers(user.id, q));
}
