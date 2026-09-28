import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { listActions, MAX_ACTIONS_PAGE } from "@/lib/mcp/actions";
import { isUuid } from "@/lib/validate";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const limitParam = req.nextUrl.searchParams.get("limit");
  const before = req.nextUrl.searchParams.get("before");
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIONS_PAGE)
  ) {
    return NextResponse.json(
      { error: `limit must be an integer from 1 to ${MAX_ACTIONS_PAGE}` },
      { status: 400 }
    );
  }
  if (before !== null && !isUuid(before)) {
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }
  return NextResponse.json(
    await listActions(user.id, { limit, before: before ?? undefined })
  );
}
