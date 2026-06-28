import { NextRequest, NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/app-url";
import { getClientIp } from "@/lib/client-ip";
import { registerInvitedUser } from "@/lib/invites";
import { rateLimit } from "@/lib/rate-limit";
import { registerSchema } from "@/lib/users";
import { sendVerificationEmail } from "@/lib/verification";

const REGISTER_IP_LIMIT = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!rateLimit(`register-ip:${ip}`, REGISTER_IP_LIMIT, REGISTER_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many sign-up attempts. Please try again later." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }

  // Registration is invite-only — the JSON body must carry an invite token.
  const invite =
    body && typeof body === "object" && "invite" in body
      ? String((body as Record<string, unknown>).invite ?? "")
      : "";
  if (!invite) {
    return NextResponse.json(
      { error: "An invite link is required to register." },
      { status: 400 }
    );
  }

  const result = await registerInvitedUser({ ...parsed.data, token: invite });
  if ("error" in result) {
    // Email already taken → 409; full / invalid invite → 403.
    const status = result.error.includes("already exists") ? 409 : 403;
    return NextResponse.json({ error: result.error }, { status });
  }

  // Email verification is required before the account can sign in.
  try {
    await sendVerificationEmail(
      result.user.id,
      result.user.email,
      getAppBaseUrl(req.headers)
    );
  } catch (err) {
    console.error("Verification email failed:", err);
  }
  return NextResponse.json(result.user, { status: 201 });
}
