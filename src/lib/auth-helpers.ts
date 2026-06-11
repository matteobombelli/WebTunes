import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export type SessionUser = { id: string; email: string; name: string | null };

/** Returns the signed-in user for API routes, or null (caller returns 401). */
export async function requireUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? null,
  };
}

/** Returns the signed-in user for pages, redirecting to /login when absent. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user) redirect("/login");
  return user;
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
