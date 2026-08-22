import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";

// Entry point for the portfolio's desktop view (matteob.dev), which embeds the
// app in an iframe and points it here so visitors get a browsable session
// without typing the public demo credentials. Only the initial iframe
// navigation qualifies (Sec-Fetch-Dest), an existing session is never
// replaced, and every other visitor is sent to the normal login page. The
// account is the read-only demo user, so this mints nothing an anonymous
// visitor couldn't already reach with the published credentials; the session
// row is inserted directly (the same shape jwt.encode mints) so embedded
// visitors behind one egress IP don't drain the login rate limits.
const DEMO_LOGIN_EMAIL = "demo1@demo.demo";

export async function GET(request: NextRequest) {
  const base = getAppBaseUrl(request.headers);
  if (await auth()) {
    return NextResponse.redirect(`${base}/discover`);
  }
  if (request.headers.get("sec-fetch-dest") !== "iframe") {
    return NextResponse.redirect(`${base}/login`);
  }
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_LOGIN_EMAIL));
  if (!user || !user.emailVerified) {
    return NextResponse.redirect(`${base}/login`);
  }
  const sessionToken = randomUUID();
  await db.insert(sessions).values({
    sessionToken,
    userId: user.id,
    expires: new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000),
  });
  const secure = base.startsWith("https://");
  const response = NextResponse.redirect(`${base}/discover`);
  response.cookies.set(
    secure ? "__Secure-authjs.session-token" : "authjs.session-token",
    sessionToken,
    {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    },
  );
  return response;
}
