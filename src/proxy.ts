import { NextRequest, NextResponse } from "next/server";

const AUTH_PAGES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
];

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
  // Public track-share listen page: reachable logged-out. Exact prefix (not
  // startsWith on "/share") so a future "/shared…" route isn't accidentally
  // exempted.
  const isPublicPage =
    pathname === "/share" || pathname.startsWith("/share/");

  if (!hasSessionCookie && !isAuthPage && !isPublicPage) {
    const url = nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  // The reverse ("cookie present + auth page → /library") is intentionally NOT
  // done here: cookie presence doesn't mean the session is valid, so a stale
  // cookie (e.g. after a password reset wipes every sessions row) would bounce
  // /login → /library while the server bounced /library → /login — an infinite
  // loop. The (auth) layout makes that redirect instead, validated against the
  // database via auth().
  return NextResponse.next();
}

export const config = {
  // PWA assets (sw.js, manifest, icons) must be reachable logged-out, or SW
  // registration/installation breaks.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|apple-icon\\.png|icon-.*\\.png|.*\\.svg$).*)",
  ],
};
