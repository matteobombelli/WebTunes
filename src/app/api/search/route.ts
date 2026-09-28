import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { searchTracks } from "@/lib/search";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope =
    scopeParam === "own" || scopeParam === "friends" ? scopeParam : "all";
  return NextResponse.json(await searchTracks(user.id, q, scope));
}
