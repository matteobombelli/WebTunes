import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { revokeExtensionToken } from "@/lib/extension-tokens";
import { isUuid } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** Revoke a connected importer extension from Settings. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { id } = await params;
  if (!isUuid(id) || !(await revokeExtensionToken(user.id, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
