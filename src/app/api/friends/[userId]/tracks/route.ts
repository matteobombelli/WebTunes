import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { areFriends } from "@/lib/friends";
import { listTracksOfFriend } from "@/lib/tracks";
import { getDisplayName } from "@/lib/users";
import { isUuid } from "@/lib/validate";

export async function GET(
  _req: NextRequest,
  { params }: RouteContext<"/api/friends/[userId]/tracks">
) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { userId } = await params;
  if (!isUuid(userId) || !(await areFriends(user.id, userId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ownerName = await getDisplayName(userId);
  return NextResponse.json(await listTracksOfFriend(userId, ownerName));
}
