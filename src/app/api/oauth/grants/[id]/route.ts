import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { revokeGrant } from "@/lib/oauth/grants";
import { isUuid } from "@/lib/validate";

export async function DELETE(
  _request: Request,
  { params }: RouteContext<"/api/oauth/grants/[id]">
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!isUuid(id) || !(await revokeGrant(user.id, id))) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
