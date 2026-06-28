"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { headers } from "next/headers";
import { signIn, signOut } from "@/lib/auth";
import { getAppBaseUrl } from "@/lib/app-url";
import { getClientIp } from "@/lib/client-ip";
import { registerInvitedUser } from "@/lib/invites";
import { rateLimit } from "@/lib/rate-limit";
import { registerSchema } from "@/lib/users";
import { sendVerificationEmail } from "@/lib/verification";

// `notice` carries non-error feedback (e.g. "check your email");
// `unverifiedEmail` is set when a login was blocked for being unverified, so
// the form can offer to resend the verification link.
export type AuthFormState = {
  error: string | null;
  notice?: string;
  unverifiedEmail?: string;
};

const REGISTER_IP_LIMIT = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  try {
    await signIn("credentials", {
      email,
      password: formData.get("password"),
      redirectTo: "/discover",
    });
    return { error: null };
  } catch (err) {
    if (err instanceof CredentialsSignin && err.code === "unverified") {
      return { error: null, unverifiedEmail: email };
    }
    if (err instanceof AuthError) {
      return { error: "Invalid email or password" };
    }
    throw err; // NEXT_REDIRECT on success
  }
}

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const ip = getClientIp(await headers());
  if (!rateLimit(`register-ip:${ip}`, REGISTER_IP_LIMIT, REGISTER_WINDOW_MS)) {
    return { error: "Too many sign-up attempts. Please try again later." };
  }

  // Registration is invite-only: the token is the authorization. The page only
  // renders the form for a valid token, but re-validate here (the form post is
  // the real trust boundary) inside registerInvitedUser's transaction.
  const token = String(formData.get("invite") ?? "");
  if (!token) return { error: "Registration is invite-only." };

  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await registerInvitedUser({ ...parsed.data, token });
  if ("error" in result) return { error: result.error };

  // Send the verification link; don't sign in until the email is confirmed.
  try {
    await sendVerificationEmail(
      result.user.id,
      result.user.email,
      getAppBaseUrl(await headers())
    );
  } catch (err) {
    console.error("Verification email failed:", err);
  }
  return {
    error: null,
    notice:
      "Account created. Check your email for a verification link to activate your account.",
  };
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
