import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { undoAction } from "@/lib/mcp/actions";
import { isUuid } from "@/lib/validate";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/mcp/actions/[id]/undo">
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Action not found" }, { status: 404 });
  }
  const result = await undoAction(user.id, id);
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    case "expired":
      return NextResponse.json(
        { error: "Undo window has passed" },
        { status: 410 }
      );
    case "already_undone":
      return NextResponse.json(
        { error: "Action was already undone" },
        { status: 409 }
      );
    case "ok":
      return NextResponse.json({ report: result.report });
  }
}
