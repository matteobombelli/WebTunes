import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { getUserForImportToken } from "@/lib/extension-tokens";

export type SessionUser = { id: string; email: string; name: string | null };

// Auth.js doesn't React-cache auth(), and with database sessions each call is
// a session+user DB round-trip — the (app) layout and every page both call
// requireUser on the same request. cache() collapses them to one.
const cachedAuth = cache(() => auth());

/** Returns the signed-in user for API routes, or null (caller returns 401). */
export async function requireUser(): Promise<SessionUser | null> {
  const session = await cachedAuth();
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

/**
 * Returns the user behind a valid `Authorization: Bearer` extension-import
 * token, or null (caller returns 401). The token-auth counterpart of
 * requireUser for the two extension routes — session auth and token auth stay
 * deliberately separate so the token's scope can't creep.
 */
export async function requireImportToken(
  req: NextRequest
): Promise<SessionUser | null> {
  return getUserForImportToken(req.headers.get("authorization"));
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
