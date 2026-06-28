import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  createInvite,
  INVITE_BLOCKED_EMAILS,
  listInvitesFor,
} from "@/lib/invites";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return NextResponse.json(await listInvitesFor(user.id));
}

export async function POST() {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (INVITE_BLOCKED_EMAILS.has(user.email)) {
    return NextResponse.json(
      { error: "Demo accounts can't send invites." },
      { status: 403 }
    );
  }
  return NextResponse.json(await createInvite(user.id), { status: 201 });
}
