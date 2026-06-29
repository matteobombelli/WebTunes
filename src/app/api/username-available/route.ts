import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { isNameTaken, nameSchema } from "@/lib/users";

// Live availability check for the username field, used by both the register form
// (logged-out) and the in-app rename. Public on purpose: usernames are public
// identifiers any signed-in user can already search, so the only new exposure is
// to logged-out callers — bounded by a per-IP rate limit. Reports whether the
// exact name is free (case-insensitive); a caller comparing against their own
// current username does so client-side, so self isn't excluded here.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!rateLimit(`username-available:${ip}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = nameSchema.safeParse(req.nextUrl.searchParams.get("name"));
  if (!parsed.success) {
    return NextResponse.json({ available: false });
  }
  return NextResponse.json({ available: !(await isNameTaken(parsed.data)) });
}
