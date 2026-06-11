import { NextRequest, NextResponse } from "next/server";

const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];

// Lightweight gate: checks cookie presence only (database sessions cannot be
// validated at the edge). Real enforcement lives in requireUser()/auth() on
// the server. Paths here exclude the basePath; nextUrl.clone() preserves it.
export function proxy(req: NextRequest) {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  if (pathname.startsWith("/api")) return NextResponse.next();

  const hasSessionCookie =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token");
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  if (!hasSessionCookie && !isAuthPage) {
    const url = nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (hasSessionCookie && isAuthPage) {
    const url = nextUrl.clone();
    url.pathname = "/library";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
