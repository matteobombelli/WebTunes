import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { rejectSuggestedImport } from "@/lib/suggested-imports";
import { isUuid } from "@/lib/validate";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  const result = await rejectSuggestedImport(user.id, id);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  if (result.status === "conflict") {
    return NextResponse.json(
      { error: "Suggestion is no longer ready" },
      { status: 409 }
    );
  }
  return new NextResponse(null, { status: 204 });
}
